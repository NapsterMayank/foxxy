import { customType } from 'drizzle-orm/pg-core';

/**
 * `citext` — case-insensitive text. Drizzle has no built-in for it.
 *
 * Email is stored as citext so that `A@B.com` and `a@b.com` cannot both be
 * registered. The application also trims and lowercases on the way in; the
 * column type is the backstop, not the only defence.
 *
 * Requires `CREATE EXTENSION citext`, which the first migration performs.
 */
export const citext = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'citext';
  },
});

/**
 * `vector(n)` — pgvector. Declared here so the corpus tables (build step 6)
 * have it available; the identity migration only enables the extension.
 */
export const vector = customType<{
  data: number[];
  driverData: string;
  config: { dimensions: number };
}>({
  dataType(config) {
    const dimensions = config?.dimensions ?? 1024;
    return `vector(${dimensions})`;
  },
  toDriver(value: number[]): string {
    return `[${value.join(',')}]`;
  },
  fromDriver(value: string): number[] {
    return JSON.parse(value) as number[];
  },
});

/**
 * `tsvector` — Postgres full-text search vector, for the sparse half of the
 * hybrid retrieval pipeline (plan §8.4, steps 4-5).
 *
 * Declared as a custom type because Drizzle has no built-in. The one column
 * that uses it (`rag_chunks.search_vector`) is GENERATED ALWAYS ... STORED, so
 * nothing ever writes to it — `toDriver` exists only to satisfy the type and
 * would be a defect if it were ever reached.
 */
export const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tsvector';
  },
});
