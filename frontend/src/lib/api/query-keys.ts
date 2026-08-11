/**
 * Every query key in the product — plan §5.3.
 *
 * Scattered string keys make cache invalidation guesswork: a mutation
 * invalidates `['practice']` while the query registered `['practice-session']`,
 * nothing errors, and the screen shows stale data until a reload. One file
 * makes invalidation a lookup instead of a search.
 *
 * `as const` throughout so a typo in a key is a type error at the call site
 * rather than a cache miss at runtime.
 */

export const sessionKeys = {
  /** The bootstrap. §5.5 — one query, and no component calls the endpoint itself. */
  currentUser: ['session', 'current-user'] as const,
} as const;

export const learnerKeys = {
  all: ['learner'] as const,
  profile: () => [...learnerKeys.all, 'profile'] as const,
  mastery: () => [...learnerKeys.all, 'mastery'] as const,
} as const;

export const contentKeys = {
  all: ['content'] as const,
  chapters: (filter: { grade?: string; subject?: string }) =>
    [...contentKeys.all, 'chapters', filter] as const,
  chapter: (chapterId: string) => [...contentKeys.all, 'chapter', chapterId] as const,
} as const;

export const practiceKeys = {
  all: ['practice'] as const,
  mission: () => [...practiceKeys.all, 'mission'] as const,
  session: (sessionId: string) => [...practiceKeys.all, 'session', sessionId] as const,
  history: () => [...practiceKeys.all, 'history'] as const,
  progress: () => [...practiceKeys.all, 'progress'] as const,
} as const;

export const foxyKeys = {
  all: ['foxy'] as const,
  capabilities: () => [...foxyKeys.all, 'capabilities'] as const,
  sessions: () => [...foxyKeys.all, 'sessions'] as const,
  session: (sessionId: string) => [...foxyKeys.all, 'session', sessionId] as const,
} as const;

export const parentKeys = {
  all: ['parent'] as const,
  children: () => [...parentKeys.all, 'children'] as const,
  snapshot: (childId: string) => [...parentKeys.all, 'snapshot', childId] as const,
  digest: (childId: string) => [...parentKeys.all, 'digest', childId] as const,
  transcript: (childId: string) => [...parentKeys.all, 'transcript', childId] as const,
  consent: (childId: string) => [...parentKeys.all, 'consent', childId] as const,
} as const;

export const billingKeys = {
  all: ['billing'] as const,
  status: () => [...billingKeys.all, 'status'] as const,
} as const;

export const notifyKeys = {
  all: ['notifications'] as const,
  list: () => [...notifyKeys.all, 'list'] as const,
  unreadCount: () => [...notifyKeys.all, 'unread-count'] as const,
} as const;
