import { describe, expect, it } from 'vitest';
import {
  billingKeys,
  contentKeys,
  foxyKeys,
  learnerKeys,
  notifyKeys,
  parentKeys,
  practiceKeys,
  sessionKeys,
} from '../query-keys';

/**
 * QUERY KEYS — plan §5.3.
 *
 * Two properties, and both are invisible until they bite:
 *
 *   PREFIXING — every key inside an area starts with that area's root, so
 *   `invalidateQueries({ queryKey: practiceKeys.all })` really does reach the
 *   session and the history. A key that forgets its prefix is not invalidated
 *   by anything, and the screen shows stale data with no error anywhere.
 *
 *   DISTINCTNESS — two areas must never produce the same key. A collision
 *   serves one area's cached data to another, which reads as data corruption
 *   rather than as a caching bug.
 */

const parameterised = [
  learnerKeys.profile(),
  learnerKeys.mastery(),
  contentKeys.chapters({ grade: '8', subject: 'science' }),
  contentKeys.chapter('chapter-1'),
  practiceKeys.mission(),
  practiceKeys.session('s1'),
  practiceKeys.history(),
  practiceKeys.progress(),
  foxyKeys.capabilities(),
  foxyKeys.sessions(),
  foxyKeys.session('f1'),
  parentKeys.children(),
  parentKeys.snapshot('c1'),
  parentKeys.digest('c1'),
  parentKeys.transcript('c1'),
  parentKeys.consent('c1'),
  billingKeys.status(),
  notifyKeys.list(),
  notifyKeys.unreadCount(),
  sessionKeys.currentUser,
];

describe('query keys', () => {
  it('are all distinct', () => {
    const serialised = parameterised.map((key) => JSON.stringify(key));
    expect(new Set(serialised).size).toBe(serialised.length);
  });

  it.each([
    ['learner', learnerKeys.all, [learnerKeys.profile(), learnerKeys.mastery()]],
    [
      'content',
      contentKeys.all,
      [contentKeys.chapters({ grade: '8' }), contentKeys.chapter('chapter-1')],
    ],
    [
      'practice',
      practiceKeys.all,
      [practiceKeys.mission(), practiceKeys.session('s1'), practiceKeys.history()],
    ],
    ['foxy', foxyKeys.all, [foxyKeys.capabilities(), foxyKeys.sessions(), foxyKeys.session('f1')]],
    [
      'parent',
      parentKeys.all,
      [parentKeys.children(), parentKeys.snapshot('c1'), parentKeys.transcript('c1')],
    ],
    ['billing', billingKeys.all, [billingKeys.status()]],
    ['notify', notifyKeys.all, [notifyKeys.list(), notifyKeys.unreadCount()]],
  ])('%s keys all start with the area root, so invalidation reaches them', (_area, root, keys) => {
    for (const key of keys) {
      expect(key.slice(0, root.length)).toEqual([...root]);
    }
  });

  it('separates the same resource id across areas', () => {
    // A child id and a practice session id can collide as strings; the area
    // prefix is what keeps their cache entries apart.
    expect(JSON.stringify(parentKeys.snapshot('x'))).not.toBe(
      JSON.stringify(practiceKeys.session('x')),
    );
  });

  it('varies a chapter list by its filter', () => {
    // Two grades are two different lists. A key that ignored the filter would
    // serve grade 8 chapters to a grade 6 student.
    expect(contentKeys.chapters({ grade: '6' })).not.toEqual(contentKeys.chapters({ grade: '8' }));
  });

  it('keeps the session key out of every feature area', () => {
    /*
     * `expire` removes every query whose root is NOT the session root. If the
     * session key ever started with a feature root it would be removed with
     * them, the bootstrap would refetch, and that is the loop the provider's
     * guard exists to prevent.
     */
    const featureRoots = [
      learnerKeys.all,
      contentKeys.all,
      practiceKeys.all,
      foxyKeys.all,
      parentKeys.all,
      billingKeys.all,
      notifyKeys.all,
    ];
    for (const root of featureRoots) {
      expect(sessionKeys.currentUser[0]).not.toBe(root[0]);
    }
  });
});
