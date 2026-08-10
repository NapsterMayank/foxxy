/**
 * The schema barrel. One file per concern, all re-exported here.
 * `drizzle-kit` and the Drizzle client both read this single entry point.
 *
 * Modules land as they are built: foxy and billing remain.
 *
 * ===========================================================================
 * IMPORT ORDER IS LOAD-BEARING, and the reason is worth stating once.
 *
 * drizzle-kit transpiles this graph to CommonJS. A cycle between two schema
 * files is therefore a temporal-dead-zone crash at generate time rather than a
 * warning (the same hazard documented at the top of
 * `shared/constants/curriculum.ts`). `tenants` is imported by identity,
 * learner, practice, schools, audit and notifications, so it imports NOTHING
 * from the rest of the schema and is listed first.
 *
 * ===========================================================================
 * TWO OF THESE FILES ARE AHEAD OF THE CODE THAT OWNS THEM. Deliberately.
 *
 *   `practice.ts`  NO LONGER AHEAD — the module landed at build step 11. Its
 *                  response log did arrive three steps early, as the third
 *                  one-way door in PROGRESS.md §8 (history cannot be
 *                  backfilled), and migration 0002 renamed it from
 *                  `question_responses` to `practice_responses` per D-057 when
 *                  the module that owns it was finally built.
 *
 *   `schools.ts`   STUBS. No module, no service, no routes. They exist so
 *                  Phase 1 has something to attach to.
 *
 *   `tenants.ts`   The Phase 5 hook, landed in Phase 0 because it is the one
 *                  item on the roadmap that cannot be retrofitted safely.
 *
 * A table that arrives before its module is a liability if nobody records why,
 * because the next person deletes it as dead code. Each file's header is that
 * record.
 */
export * from './tenants';
export * from './identity';
export * from './learner';
export * from './content';
export * from './pedagogy';
export * from './practice';
export * from './parent';
export * from './schools';
export * from './audit';
export * from './notifications';
export * from './observability';
export * from './jobs';
