import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ForbiddenError, NotFoundError } from '@/platform/errors/index';
import type { Actor } from '@/platform/authz/index';
import type { Grade } from '@/shared/constants/curriculum';
import {
  TEST_TENANT_ID,
  onboardAccount,
  startAppHarness,
  type AppHarness,
} from '../../../../tests/helpers/app-harness';
import {
  insertChapter,
  insertQuestion,
  insertRagChunk,
  makeChapter,
  makeQuestion,
  makeRagChunk,
} from '../../../../tests/fixtures/index';

/**
 * content service tests — a real Postgres, faked everything else (§9.1).
 *
 * The §8.3 checklist, in order:
 *
 *   questions are filtered by grade and subject
 *   inactive questions are never returned
 *   HELD-OUT questions are never returned by the practice-facing function
 *   a question with other than 4 options is rejected
 *   `correct_index` outside 0..3 is rejected
 *
 * The last two are CONSTRAINT tests and they belong here rather than only in
 * the migration suite: they are the content module's rules, and the module is
 * where someone would later "improve" the insert path and quietly bypass them.
 * They are exercised through the fixtures, starting from a valid row and
 * breaking exactly one field, so a failure names the field and not a guess.
 */

let harness: AppHarness;
let actor: Actor;

const GRADE: Grade = '8';
const SUBJECT = 'science';

beforeAll(async () => {
  harness = await startAppHarness();
}, 240_000);

afterAll(async () => {
  await harness.stop();
}, 60_000);

beforeEach(async () => {
  await harness.reset();
  const account = await onboardAccount(harness, 'reader@example.test', 'student');
  actor = { userId: account.userId, role: 'student', tenantId: TEST_TENANT_ID };
});

/** A chapter, and the numbers kept distinct so the natural key never collides. */
let chapterNumber = 0;
async function chapter(
  overrides: Partial<{ grade: Grade; subjectCode: string; isActive: boolean }> = {},
): Promise<string> {
  chapterNumber += 1;
  return insertChapter(
    harness.postgres.client,
    makeChapter(`c${String(chapterNumber)}`, {
      grade: GRADE,
      subjectCode: SUBJECT,
      chapterNumber,
      ...overrides,
    }),
  );
}

describe('listChapters', () => {
  it('returns active chapters for a grade and subject', async () => {
    await chapter();
    await chapter();
    const chapters = await harness.content.service.listChapters(actor, {
      grade: GRADE,
      subject: SUBJECT,
      limit: 100,
    });
    expect(chapters).toHaveLength(2);
  });

  it('filters by GRADE — a grade 7 request never sees grade 9 content', async () => {
    await chapter({ grade: '7' });
    await chapter({ grade: '9' });

    const chapters = await harness.content.service.listChapters(actor, {
      grade: '7',
      limit: 100,
    });
    expect(chapters.map((row) => row.grade)).toEqual(['7']);
  });

  it('filters by SUBJECT', async () => {
    await chapter({ subjectCode: 'science' });
    await chapter({ subjectCode: 'maths' });

    const chapters = await harness.content.service.listChapters(actor, {
      subject: 'maths',
      limit: 100,
    });
    expect(chapters.map((row) => row.subjectCode)).toEqual(['maths']);
  });

  it('NEVER lists a withdrawn chapter, and has no option to', async () => {
    // `is_active = false` is how a chapter is withdrawn. A listing that could
    // be asked to include withdrawn chapters is one that will be, by a caller
    // passing a flag through from a query string.
    await chapter({ isActive: false });
    await expect(harness.content.service.listChapters(actor, { limit: 100 })).resolves.toEqual([]);
  });

  it('honours the limit', async () => {
    await chapter();
    await chapter();
    await chapter();
    const chapters = await harness.content.service.listChapters(actor, { limit: 2 });
    expect(chapters).toHaveLength(2);
  });

  it('orders by grade, subject, then chapter number — syllabus order', async () => {
    await chapter({ subjectCode: 'science' });
    await chapter({ subjectCode: 'maths' });
    const chapters = await harness.content.service.listChapters(actor, { limit: 100 });
    expect(chapters.map((row) => row.subjectCode)).toEqual(['maths', 'science']);
  });

  it('returns titleHi as NULL when it has not been written', async () => {
    // A visible gap the UI can fall back from, rather than an English string
    // wearing a Hindi field name (P7).
    chapterNumber += 1;
    await insertChapter(
      harness.postgres.client,
      makeChapter('nohi', { chapterNumber, titleHi: null }),
    );
    const chapters = await harness.content.service.listChapters(actor, { limit: 100 });
    expect(chapters[0]?.titleHi).toBeNull();
  });
});

describe('getChapter', () => {
  it('returns one chapter by id', async () => {
    const id = await chapter();
    await expect(harness.content.service.getChapter(actor, id)).resolves.toMatchObject({ id });
  });

  it('404s for an id that does not exist', async () => {
    await expect(
      harness.content.service.getChapter(actor, '00000000-0000-0000-0000-000000000000'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('404s for a WITHDRAWN chapter, indistinguishably from an absent one', async () => {
    // Telling them apart would let anyone enumerate withdrawn content, and
    // "this chapter has been withdrawn" is not something a student can act on.
    const id = await chapter({ isActive: false });
    const withdrawn = await harness.content.service
      .getChapter(actor, id)
      .catch((error: unknown) => error);
    const absent = await harness.content.service
      .getChapter(actor, '00000000-0000-0000-0000-000000000000')
      .catch((error: unknown) => error);

    expect(JSON.stringify((withdrawn as NotFoundError).toClientPayload())).toBe(
      JSON.stringify((absent as NotFoundError).toClientPayload()),
    );
  });
});

describe('getQuestionsForChapter — §8.3', () => {
  let chapterId: string;

  beforeEach(async () => {
    chapterId = await chapter();
  });

  const query = (overrides: Partial<{ grade: Grade; subjectCode: string; limit: number }> = {}) => ({
    chapterId,
    grade: GRADE,
    subjectCode: SUBJECT,
    ...overrides,
  });

  it('returns the chapter’s active practice questions', async () => {
    await insertQuestion(harness.postgres.client, chapterId, makeQuestion('q1'));
    await insertQuestion(harness.postgres.client, chapterId, makeQuestion('q2'));

    const questions = await harness.content.service.getQuestionsForChapter(actor, query());
    expect(questions).toHaveLength(2);
    expect(questions[0]?.options).toHaveLength(4);
  });

  it('returns NOTHING when the grade does not match the chapter’s', async () => {
    // The filter is a JOIN on `chapters`, so a chapter id from the wrong grade
    // yields an empty list rather than grade 9 questions for a grade 7 student.
    await insertQuestion(harness.postgres.client, chapterId, makeQuestion('q1'));
    await expect(
      harness.content.service.getQuestionsForChapter(actor, query({ grade: '9' })),
    ).resolves.toEqual([]);
  });

  it('returns NOTHING when the subject does not match', async () => {
    await insertQuestion(harness.postgres.client, chapterId, makeQuestion('q1'));
    await expect(
      harness.content.service.getQuestionsForChapter(actor, query({ subjectCode: 'maths' })),
    ).resolves.toEqual([]);
  });

  it('NEVER returns an inactive question', async () => {
    await insertQuestion(harness.postgres.client, chapterId, makeQuestion('live'));
    await insertQuestion(
      harness.postgres.client,
      chapterId,
      makeQuestion('dead', { isActive: false }),
    );

    const questions = await harness.content.service.getQuestionsForChapter(actor, query());
    expect(questions).toHaveLength(1);
    expect(questions[0]?.questionText).toContain('live');
  });

  it('returns NOTHING for a withdrawn chapter, even if its questions are active', async () => {
    const withdrawn = await chapter({ isActive: false });
    await insertQuestion(harness.postgres.client, withdrawn, makeQuestion('orphan'));
    await expect(
      harness.content.service.getQuestionsForChapter(actor, { ...query(), chapterId: withdrawn }),
    ).resolves.toEqual([]);
  });

  it('honours the limit', async () => {
    for (const seed of ['a', 'b', 'c']) {
      await insertQuestion(harness.postgres.client, chapterId, makeQuestion(seed));
    }
    await expect(
      harness.content.service.getQuestionsForChapter(actor, query({ limit: 2 })),
    ).resolves.toHaveLength(2);
  });

  it('reads misconceptions BY OPTION INDEX, the shape migration 0003 introduced', async () => {
    await insertQuestion(
      harness.postgres.client,
      chapterId,
      makeQuestion('mis', { correctIndex: 1 }),
    );
    const questions = await harness.content.service.getQuestionsForChapter(actor, query());
    const codes = questions[0]?.distractorMisconceptions;

    expect(Object.keys(codes ?? {}).sort()).toEqual(['0', '2', '3']);
    // The lookup this shape makes possible: which misconception did option 2
    // represent? Asked directly, with no reference to `correct_index` and no
    // counting — which is exactly how a reordering used to mislabel every code.
    expect(codes?.['2']).toContain('opt2');
  });
});

describe('the held-out reserve — never served in practice', () => {
  let chapterId = '';

  beforeEach(async () => {
    chapterId = await chapter();
  });

  /** Built per call, because `chapterId` is only known inside a test. */
  const query = (): { chapterId: string; grade: Grade; subjectCode: string } => ({
    chapterId,
    grade: GRADE,
    subjectCode: SUBJECT,
  });

  it('EXCLUDES held-out questions from the practice-facing function', async () => {
    // THE ONE-WAY DOOR (PROGRESS.md §8). A question served in practice may
    // have been memorised and can never measure anything again — for that
    // student, permanently. There is no cleanup and no recovery.
    await insertQuestion(harness.postgres.client, chapterId, makeQuestion('practice'));
    await insertQuestion(
      harness.postgres.client,
      chapterId,
      makeQuestion('reserved', { isHeldOut: true }),
    );

    const questions = await harness.content.service.getQuestionsForChapter(actor, query());

    expect(questions).toHaveLength(1);
    expect(questions[0]?.isHeldOut).toBe(false);
    expect(questions[0]?.questionText).toContain('practice');
  });

  it('returns an empty list when EVERY question is held out', async () => {
    // Rather than falling back to the reserve because "there is nothing else".
    // A thin practice pool is a content problem; contaminating the reserve to
    // hide it is unrecoverable.
    await insertQuestion(
      harness.postgres.client,
      chapterId,
      makeQuestion('all-reserved', { isHeldOut: true }),
    );
    await expect(
      harness.content.service.getQuestionsForChapter(actor, query()),
    ).resolves.toEqual([]);
  });

  it('has NO argument that could include the reserve', async () => {
    // The protection is the shape of the interface, not the discipline of the
    // caller. A boolean with a safe default would put contamination one
    // forgotten argument away, and forgetting an argument is not a rare event.
    await insertQuestion(
      harness.postgres.client,
      chapterId,
      makeQuestion('reserved', { isHeldOut: true }),
    );

    const smuggled = {
      ...query(),
      includeHeldOut: true,
      heldOut: true,
      pool: 'held-out',
    } as unknown as ReturnType<typeof query>;

    await expect(
      harness.content.service.getQuestionsForChapter(actor, smuggled),
    ).resolves.toEqual([]);
  });

  it('serves the reserve ONLY through the separately named function', async () => {
    await insertQuestion(harness.postgres.client, chapterId, makeQuestion('practice'));
    await insertQuestion(
      harness.postgres.client,
      chapterId,
      makeQuestion('reserved', { isHeldOut: true }),
    );

    const heldOut = await harness.content.service.getHeldOutQuestionsForChapter(actor, query());

    expect(heldOut).toHaveLength(1);
    expect(heldOut[0]?.isHeldOut).toBe(true);
  });

  it('applies the same grade and subject filter to the reserve', async () => {
    await insertQuestion(
      harness.postgres.client,
      chapterId,
      makeQuestion('reserved', { isHeldOut: true }),
    );
    await expect(
      harness.content.service.getHeldOutQuestionsForChapter(actor, { ...query(), grade: '9' }),
    ).resolves.toEqual([]);
  });
});

describe('a question’s shape is enforced by the database — §8.3', () => {
  let chapterId: string;

  beforeEach(async () => {
    chapterId = await chapter();
  });

  it('REJECTS a question with three options', async () => {
    // Application validation protects the paths that run it; a CHECK protects
    // the paths nobody remembered — the bulk import, the admin fix-up, the
    // psql session at 2am. A three-option question renders a broken quiz for
    // every student who draws it.
    await expect(
      insertQuestion(
        harness.postgres.client,
        chapterId,
        makeQuestion('three', { options: ['a', 'b', 'c'] }),
      ),
    ).rejects.toThrow(/questions_options_check/);
  });

  it('REJECTS a question with five options', async () => {
    await expect(
      insertQuestion(
        harness.postgres.client,
        chapterId,
        makeQuestion('five', { options: ['a', 'b', 'c', 'd', 'e'] }),
      ),
    ).rejects.toThrow(/questions_options_check/);
  });

  it('REJECTS an empty-string option', async () => {
    await expect(
      insertQuestion(
        harness.postgres.client,
        chapterId,
        makeQuestion('empty', { options: ['a', '', 'c', 'd'] }),
      ),
    ).rejects.toThrow(/questions_options_check/);
  });

  it('REJECTS correct_index of 4 — one past the end', async () => {
    await expect(
      insertQuestion(
        harness.postgres.client,
        chapterId,
        makeQuestion('over', { correctIndex: 4 }),
      ),
    ).rejects.toThrow(/questions_correct_index_check/);
  });

  it('REJECTS a negative correct_index', async () => {
    await expect(
      insertQuestion(
        harness.postgres.client,
        chapterId,
        makeQuestion('under', { correctIndex: -1 }),
      ),
    ).rejects.toThrow(/questions_correct_index_check/);
  });

  it('accepts correct_index at both ends of the range', async () => {
    for (const correctIndex of [0, 3]) {
      await expect(
        insertQuestion(
          harness.postgres.client,
          chapterId,
          makeQuestion(`edge${String(correctIndex)}`, { correctIndex }),
        ),
      ).resolves.toBeTruthy();
    }
  });

  it('serves exactly four options for every question it returns', async () => {
    // The read side of the same rule: `correct_index` 0..3 alongside exactly
    // four options means the index can never point past the end of the array.
    await insertQuestion(harness.postgres.client, chapterId, makeQuestion('shape'));
    const questions = await harness.content.service.getQuestionsForChapter(actor, {
      chapterId,
      grade: GRADE,
      subjectCode: SUBJECT,
    });
    const question = questions[0];
    expect(question?.options).toHaveLength(4);
    expect(question?.options[question.correctIndex]).toBeDefined();
  });
});

describe('getChunksByIds — what retrieval will call', () => {
  it('returns the requested chunks', async () => {
    const first = await insertRagChunk(harness.postgres.client, makeRagChunk('k1'));
    const second = await insertRagChunk(harness.postgres.client, makeRagChunk('k2'));

    const chunks = await harness.content.service.getChunksByIds(actor, [first, second]);
    expect(chunks.map((chunk) => chunk.id).sort()).toEqual([first, second].sort());
  });

  it('returns an EMPTY array for an empty id list, rather than raising', async () => {
    // `in ()` is not valid SQL, and an abstaining retrieval turn legitimately
    // produces no ids — that path must return nothing rather than throw
    // (§8.4: "an empty result abstains rather than throwing").
    await expect(harness.content.service.getChunksByIds(actor, [])).resolves.toEqual([]);
  });

  it('skips an inactive chunk', async () => {
    const active = await insertRagChunk(harness.postgres.client, makeRagChunk('live'));
    const inactive = await insertRagChunk(
      harness.postgres.client,
      makeRagChunk('dead', { isActive: false }),
    );

    const chunks = await harness.content.service.getChunksByIds(actor, [active, inactive]);
    expect(chunks.map((chunk) => chunk.id)).toEqual([active]);
  });

  it('ignores an unknown id instead of failing the whole batch', async () => {
    // Retrieval ranks, then hydrates. A chunk deactivated between those two
    // steps must cost one citation, not the entire answer.
    const known = await insertRagChunk(harness.postgres.client, makeRagChunk('k3'));
    const chunks = await harness.content.service.getChunksByIds(actor, [
      known,
      '00000000-0000-0000-0000-000000000000',
    ]);
    expect(chunks).toHaveLength(1);
  });

  it('carries the citation fields and NOT the embedding', async () => {
    // A 1024-float array per chunk, fifty chunks per answer, for data nobody
    // reads — several megabytes of traffic per turn.
    const id = await insertRagChunk(harness.postgres.client, makeRagChunk('cite'));
    const chunk = (await harness.content.service.getChunksByIds(actor, [id]))[0];

    expect(chunk?.chunkText.length).toBeGreaterThan(0);
    expect(chunk?.chapterTitle).toBeDefined();
    expect('embedding' in (chunk ?? {})).toBe(false);
    expect('searchVector' in (chunk ?? {})).toBe(false);
  });
});

describe('content is read-only, for any authenticated actor (D-003)', () => {
  it('lets a PARENT read chapters — curriculum belongs to no student', async () => {
    await chapter();
    const parent = await onboardAccount(harness, 'parent-reader@example.test', 'parent');
    await expect(
      harness.content.service.listChapters(
        { userId: parent.userId, role: 'parent', tenantId: TEST_TENANT_ID },
        { limit: 100 },
      ),
    ).resolves.toHaveLength(1);
  });

  it('has no write use-case at all — nothing authors curriculum over the API', () => {
    const surface = Object.keys(harness.content.service);
    expect(surface.some((name) => /create|update|delete|write/i.test(name))).toBe(false);
  });

  it('denies a write attempt at the guard, if one were ever added', () => {
    /**
     * PINNING D-003 AT THE BOUNDARY, AND NOTHING ABOUT THIS MODULE.
     *
     * READ THE CALL: it goes to `harness.container.authz` DIRECTLY, reaching
     * PAST `content.service`. So it asserts one thing only — that the authz
     * table refuses `write` on `kind: 'content'` — and it asserts NOTHING about
     * whether `content.service` consults the guard at all. It stays green with
     * `authoriseRead` gutted to a no-op.
     *
     * That is not a defect in this test; it is its scope, and the comment here
     * used to claim otherwise. The assertion that `content.service` actually
     * calls the guard is the `tenantId: ''` block below, which goes through the
     * SERVICE for every use-case.
     */
    expect(() => {
      harness.container.authz.assertCanAccess(actor, 'write', { kind: 'content' });
    }).toThrow(ForbiddenError);
  });
});

// ---------------------------------------------------------------------------
// THE GUARD IS REACHED — one case per use-case
// ---------------------------------------------------------------------------

describe('`authoriseRead` is CALLED, on every use-case', () => {
  /**
   * ==========================================================================
   * WHY A TEST PER METHOD, WHEN THEY ALL CALL THE SAME ONE-LINE HELPER.
   *
   * Replacing the body of `authoriseRead` with a no-op left 50/50 passing. The
   * guard looked installed and enforced nothing — the seventh defect of that
   * shape found in this codebase.
   *
   * It survived for a specific reason: `kind: 'content'` carries no tenant (the
   * NCERT corpus is shared curriculum, and migration 0004 gives `chapters`,
   * `questions` and `rag_chunks` no `tenant_id` at all), so the OWNERSHIP half
   * of the guard is vacuous here BY DESIGN, and the read rule allows every
   * authenticated actor. Nothing an ordinary test does can tell "allowed" from
   * "not asked".
   *
   * The live effect is the other half — `assertTenantMatch`'s first line, whose
   * own comment states the rule: *an actor with no tenant is not a
   * half-authenticated caller, it is a wiring defect, and it must not be able
   * to reach anything at all*. With the guard gutted, an actor whose `tenantId`
   * is `''` or whitespace reaches THE ENTIRE CURRICULUM.
   *
   * ==========================================================================
   * AND ONLY TWO OF THE FIVE METHODS HAVE AN HTTP ROUTE.
   *
   * `listChapters` and `getChapter` are reachable over the wire, where the
   * session plugin resolves a real tenant. `getQuestionsForChapter`,
   * `getHeldOutQuestionsForChapter` and `getChunksByIds` are called
   * MODULE-TO-MODULE — by `practice` and by `retrieval`, with an actor those
   * modules assembled. For those three `authoriseRead` is the ONLY
   * authorisation anywhere in the path, and there is no route-level check to
   * mask its absence.
   *
   * So: one assertion per use-case, through the SERVICE, with an actor whose
   * tenant is not a tenant.
   * ==========================================================================
   */

  /** The wiring defect, in the two shapes it arrives in. */
  const NO_TENANT: readonly { readonly label: string; readonly tenantId: string }[] = [
    { label: 'an empty tenant', tenantId: '' },
    // Whitespace, because `isTenant` trims — a NOT NULL column and a
    // `?? ''`-shaped repair both produce exactly this.
    { label: 'a whitespace tenant', tenantId: '   ' },
  ];

  for (const { label, tenantId } of NO_TENANT) {
    describe(label, () => {
      function tenantless(): Actor {
        return { userId: actor.userId, role: 'student', tenantId };
      }

      it('is refused by listChapters', async () => {
        await chapter();
        await expect(
          harness.content.service.listChapters(tenantless(), { limit: 100 }),
        ).rejects.toThrow(ForbiddenError);
      });

      it('is refused by getChapter', async () => {
        const id = await chapter();
        await expect(harness.content.service.getChapter(tenantless(), id)).rejects.toThrow(
          ForbiddenError,
        );
      });

      it('is refused by getQuestionsForChapter — NO ROUTE MASKS THIS ONE', async () => {
        const chapterId = await chapter();
        await insertQuestion(harness.postgres.client, chapterId, makeQuestion('q-guard'));
        await expect(
          harness.content.service.getQuestionsForChapter(tenantless(), {
            chapterId,
            grade: GRADE,
            subjectCode: SUBJECT,
          }),
        ).rejects.toThrow(ForbiddenError);
      });

      it('is refused by getHeldOutQuestionsForChapter — the RESERVE, and no route either', async () => {
        // The one that cannot be undone. A held-out question that leaves the
        // module has been spent permanently, so this is the method where "the
        // guard was never called" costs the most and shows the least.
        const chapterId = await chapter();
        await insertQuestion(
          harness.postgres.client,
          chapterId,
          makeQuestion('q-held', { isHeldOut: true }),
        );
        await expect(
          harness.content.service.getHeldOutQuestionsForChapter(tenantless(), {
            chapterId,
            grade: GRADE,
            subjectCode: SUBJECT,
          }),
        ).rejects.toThrow(ForbiddenError);
      });

      it('is refused by getChunksByIds — even for an EMPTY id list', async () => {
        // Empty deliberately: the abstaining path returns `[]` without touching
        // the database, so if the guard were skipped this would resolve rather
        // than throw, and the refusal here can only have come from the guard.
        await expect(harness.content.service.getChunksByIds(tenantless(), [])).rejects.toThrow(
          ForbiddenError,
        );
      });
    });
  }

  it('serves the same calls to the SAME actor once it carries a tenant — the control', async () => {
    // Without this, every assertion above would be satisfied by a service that
    // refuses everything, and the block would prove nothing about the guard.
    const chapterId = await chapter();
    await expect(
      harness.content.service.listChapters(actor, { limit: 100 }),
    ).resolves.toHaveLength(1);
    await expect(harness.content.service.getChapter(actor, chapterId)).resolves.toBeDefined();
    await expect(
      harness.content.service.getQuestionsForChapter(actor, {
        chapterId,
        grade: GRADE,
        subjectCode: SUBJECT,
      }),
    ).resolves.toEqual([]);
    await expect(
      harness.content.service.getHeldOutQuestionsForChapter(actor, {
        chapterId,
        grade: GRADE,
        subjectCode: SUBJECT,
      }),
    ).resolves.toEqual([]);
    await expect(harness.content.service.getChunksByIds(actor, [])).resolves.toEqual([]);
  });
});
