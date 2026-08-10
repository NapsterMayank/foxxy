/**
 * DETERMINISTIC PRIMARY KEYS — what makes the corpus import re-runnable.
 *
 * ===========================================================================
 * THE PROBLEM THIS SOLVES.
 *
 * `questions.id` and `rag_chunks.id` are `uuid primary key default
 * gen_random_uuid()`, and neither table has a column recording where the row
 * came from. The source ids therefore have nowhere to live, and a naive
 * importer that INSERTs 2,741 questions and 4,686 chunks produces 2,741 more
 * questions and 4,686 more chunks the second time it is run — silently, with no
 * constraint violated, because a random uuid never collides.
 *
 * That is not a hypothetical: an import gets re-run. It is re-run because it
 * failed halfway, because the extract was refreshed, because D-079's plan is to
 * GENERATE MORE QUESTIONS for thin chapters and import them. A duplicated bank
 * is worse than a failed import: practice serves the same question twice,
 * mastery is computed over doubled counts, and the held-out reserve covers
 * half of what it thinks it does.
 *
 * ===========================================================================
 * WHY UUIDv5 AND NOT A `source_id` COLUMN.
 *
 * A `source_id text unique` column would also work and is arguably tidier. It
 * is rejected here for three reasons, in order of weight:
 *
 *  1. It is a schema change to `questions` and `rag_chunks` — two tables whose
 *     shape was deliberately settled to make this import a straight column
 *     mapping (`content.ts` header, D-040). Adding a column for the importer's
 *     convenience puts importer concerns into the serving schema permanently.
 *  2. The uuid IS the natural key once it is derived from one. `ON CONFLICT
 *     (id) DO UPDATE` then needs no extra index, no extra lookup and no
 *     second round trip to translate a source id into ours.
 *  3. Every foreign key already points at `id`. A chunk's `chapter_id` can be
 *     computed from the chapter's KEY without the chapter having been inserted
 *     yet, which is what lets the chunk stream be written in one pass.
 *
 * ===========================================================================
 * THE NAMESPACE IS FROZEN. CHANGING IT DUPLICATES THE CORPUS.
 *
 * Every id below is a function of (NAMESPACE, kind, source key). Change any of
 * the three and every row gets a new primary key, so the next import inserts a
 * complete second copy alongside the first rather than updating it — the exact
 * failure this module exists to prevent, arriving through its own constant.
 *
 * The kind prefix is what keeps the four id spaces apart. A question and a
 * chunk could in principle carry the same source uuid (they come from different
 * tables in a database we do not control), and without the prefix they would
 * derive the same id in two different tables — harmless today, and the kind of
 * coincidence that is impossible to debug the day it is not.
 */

import { createHash } from 'node:crypto';

/**
 * The RFC 4122 namespace for every id this import derives. Frozen — see header.
 *
 * Generated once, at random, and written down. It is not secret and it is not
 * a checksum; it exists so that these ids cannot collide with uuids minted by
 * any other system that happens to hash the same strings.
 */
export const CORPUS_ID_NAMESPACE = '6f4c9d2e-1b73-4f8a-9c5d-2a7e0b6f31d4';

/** The id spaces this import mints into. One per destination table. */
export type CorpusIdKind = 'chapter' | 'question' | 'chunk' | 'concept' | 'edge' | 'misconception';

function namespaceBytes(namespace: string): Buffer {
  return Buffer.from(namespace.replace(/-/g, ''), 'hex');
}

const NAMESPACE_BYTES = namespaceBytes(CORPUS_ID_NAMESPACE);

/**
 * RFC 4122 §4.3 name-based uuid, SHA-1 variant (version 5).
 *
 * Written out rather than taken from a dependency because it is eleven lines
 * and because the `uuid` package is not currently a dependency; adding one for
 * this would be a larger change than the function.
 *
 * SHA-1 is specified by the RFC and is NOT being used as a security primitive
 * here — collision resistance against an adversary is irrelevant when the
 * inputs are our own extract's primary keys.
 */
export function uuidV5(name: string, namespace: Buffer = NAMESPACE_BYTES): string {
  const hash = createHash('sha1').update(namespace).update(name, 'utf8').digest();

  const bytes = Buffer.from(hash.subarray(0, 16));
  // Version 5 in the high nibble of byte 6; RFC 4122 variant in byte 8.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = bytes.toString('hex');

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/**
 * The id a corpus row will have, in this database, for ever.
 *
 * `key` is the SOURCE identity: a source uuid for questions, chunks, concepts,
 * edges and misconceptions, and the chapter KEY (`'8|science|4'`) for chapters,
 * which have no source row at all — our `chapters` table is derived, and its
 * identity is the triple that derived it.
 */
export function corpusId(kind: CorpusIdKind, key: string): string {
  return uuidV5(`${kind}:${key}`);
}
