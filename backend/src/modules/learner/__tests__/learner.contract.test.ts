import { describe, expect, it } from 'vitest';
import { GRADES } from '@/shared/constants/curriculum';
import {
  gradeSchema,
  languageSchema,
  masteryScoreSchema,
  onboardingRequestSchema,
  updateProfileRequestSchema,
} from '@/shared/contracts/learner.contract';

/**
 * The learner contract — and specifically the two assertions §8.2 names:
 *
 *   "grade accepts only the strings "6" to "12""
 *   "grade 6 as a NUMBER is rejected"
 *
 * THE SECOND IS THE IMPORTANT ONE, and this file is the only place in the
 * codebase where it is enforced at all. A companion test in
 * `tests/integration/learner-content-migration.test.ts` proves the DATABASE
 * cannot do it: `insert into students (..., grade) values (..., 6)` succeeds
 * and stores '6', because Postgres assignment-casts integer to text silently
 * (D-038).
 *
 * So these are not "schema tests" in the decorative sense. Delete `gradeSchema`
 * believing the CHECK has it covered and JSON numbers start reaching the grade
 * column, where they are converted and never seen again — and the resulting
 * failure is an empty question list for one cohort, not an error.
 */

describe('gradeSchema — §8.2', () => {
  it('accepts every grade from "6" to "12"', () => {
    for (const grade of GRADES) {
      expect(gradeSchema.parse(grade)).toBe(grade);
    }
  });

  it('REJECTS the integer 6 — the rule only this schema can enforce', () => {
    const result = gradeSchema.safeParse(6);
    expect(result.success).toBe(false);
  });

  it('rejects every grade given as a number, not just 6', () => {
    for (const grade of [6, 7, 8, 9, 10, 11, 12]) {
      expect(gradeSchema.safeParse(grade).success).toBe(false);
    }
  });

  it('says WHY a number was rejected, in words a client can act on', () => {
    const result = gradeSchema.safeParse(6);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('must be a string');
    }
  });

  it('rejects a numeric string outside the range', () => {
    // The same near-misses the database CHECK refuses, refused a layer earlier
    // so the client gets a 400 naming the field instead of a 500.
    for (const grade of ['5', '13', '0', '-6']) {
      expect(gradeSchema.safeParse(grade).success).toBe(false);
    }
  });

  it('rejects the near-misses a bulk import produces', () => {
    for (const grade of ['05', '6 ', ' 6', 'Class 6', 'VI', '6.0']) {
      expect(gradeSchema.safeParse(grade).success).toBe(false);
    }
  });

  it('rejects null, undefined and a boolean', () => {
    for (const value of [null, undefined, true]) {
      expect(gradeSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe('languageSchema', () => {
  it('accepts "en" and "hi"', () => {
    expect(languageSchema.parse('en')).toBe('en');
    expect(languageSchema.parse('hi')).toBe('hi');
  });

  it('rejects anything else, including a language index', () => {
    for (const value of ['fr', 'EN', '', 0, 1]) {
      expect(languageSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe('masteryScoreSchema — REFUSES rather than clamps', () => {
  it('accepts both ends of the range', () => {
    expect(masteryScoreSchema.parse(0)).toBe(0);
    expect(masteryScoreSchema.parse(1)).toBe(1);
  });

  it('rejects a value outside it, rather than silently clamping', () => {
    // A caller sending 1.4 has a bug. Clamping at the HTTP boundary would hide
    // that bug behind a plausible-looking 1.0. The clamp in `domain/mastery.ts`
    // is for values the system COMPUTED, where 1.0000001 is arithmetic and not
    // a bug — see the note there.
    expect(masteryScoreSchema.safeParse(1.4).success).toBe(false);
    expect(masteryScoreSchema.safeParse(-0.1).success).toBe(false);
  });

  it('rejects a numeric string', () => {
    expect(masteryScoreSchema.safeParse('0.5').success).toBe(false);
  });
});

describe('onboardingRequestSchema', () => {
  const valid = {
    displayName: 'Aarav',
    grade: '8',
    subjects: ['science', 'maths'],
  };

  it('accepts a minimal valid request', () => {
    const parsed = onboardingRequestSchema.parse(valid);
    expect(parsed.grade).toBe('8');
    expect(parsed.preferredLanguage).toBeUndefined();
  });

  it('rejects a request whose grade is a number', () => {
    expect(onboardingRequestSchema.safeParse({ ...valid, grade: 8 }).success).toBe(false);
  });

  it('lower-cases and trims subject codes', () => {
    // So "Science" and "science " cannot become two rows in a table whose
    // primary key is (student, subject).
    const parsed = onboardingRequestSchema.parse({ ...valid, subjects: [' Science ', 'MATHS'] });
    expect(parsed.subjects).toEqual(['science', 'maths']);
  });

  it('requires at least one subject', () => {
    expect(onboardingRequestSchema.safeParse({ ...valid, subjects: [] }).success).toBe(false);
  });

  it('rejects an empty display name', () => {
    expect(onboardingRequestSchema.safeParse({ ...valid, displayName: '   ' }).success).toBe(false);
  });
});

describe('updateProfileRequestSchema', () => {
  it('accepts a single field', () => {
    expect(updateProfileRequestSchema.parse({ displayName: 'Neha' }).displayName).toBe('Neha');
  });

  it('rejects an EMPTY patch', () => {
    // An empty body would otherwise be a successful update that changed
    // nothing, and the caller — a form that failed to serialise its state —
    // would be told everything went fine.
    expect(updateProfileRequestSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a numeric grade in a patch, exactly as onboarding does', () => {
    // Both doors, not just the front one. A PATCH is the second and quieter
    // way a grade enters the system.
    expect(updateProfileRequestSchema.safeParse({ grade: 9 }).success).toBe(false);
  });

  it('has no `board` field — changing a board is a migration, not an edit', () => {
    // A board sent anyway is STRIPPED rather than applied. Changing a board
    // re-points the whole curriculum a student sees; that is a migration, not
    // a profile edit.
    const parsed = updateProfileRequestSchema.parse({ displayName: 'Neha', board: 'ICSE' });
    expect('board' in parsed).toBe(false);
  });
});
