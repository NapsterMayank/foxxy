/**
 * The pgvector TEXT form, parsed back into numbers.
 *
 * ===========================================================================
 * WHY THIS EXISTS AT ALL.
 *
 * The extract was written by `select to_jsonb(row)`, and pgvector's `vector`
 * type renders as a STRING in json — `"[-0.006236853,-0.04410643,...]"`. So
 * every one of the 4,666 embedded chunks in `chunks.ndjson` carries its vector
 * as 20-odd kilobytes of text, not as a json array.
 *
 * It would be shorter to hand that string straight to Postgres, which accepts
 * exactly that literal. It is parsed instead, for one reason: THE WIDTH HAS TO
 * BE CHECKED. `rag_chunks.embedding` is `vector(1024)`, and a vector of the
 * wrong width is the single worst thing this import could get past itself —
 * either it is rejected 3,000 rows into a transaction, or (if the column were
 * ever widened to an unconstrained `vector`) it is accepted and every cosine
 * distance computed against it is meaningless. TypeScript cannot check the
 * length of an array read out of a file, so it is checked here, at runtime,
 * once per row, against `EMBEDDING_DIMENSIONS`.
 *
 * ===========================================================================
 * THE ROUND TRIP IS EXACT, AND THAT IS NOT AN ASSUMPTION.
 *
 * Postgres prints a float in its shortest form that round-trips, and
 * JavaScript's `Number.prototype.toString` does the same. So parsing to a
 * double and re-joining reproduces the identical string; no vector is
 * perturbed by passing through here. `NEVER FABRICATE A VECTOR` is the rule
 * this module is downstream of — a chunk with no embedding returns `null` and
 * is imported with a NULL, never a zero vector, which would be a plausible
 * point in the space that retrieval would happily return.
 */

import { EMBEDDING_DIMENSIONS } from '../constants/curriculum';

export type VectorParseResult =
  | { readonly ok: true; readonly vector: readonly number[] | null }
  | { readonly ok: false; readonly reason: string };

/**
 * Parses `"[a,b,c]"` into numbers, or says why it could not.
 *
 * A result type rather than a throw, because the caller is a 4,686-row loop
 * that has to be able to name the offending id. Absence — `null`, `undefined`,
 * or an empty string — is `{ ok: true, vector: null }`: a chunk with no
 * embedding is a FACT about the corpus (20 of them, D-078), not an error.
 */
export function parseVectorText(raw: unknown): VectorParseResult {
  if (raw === null || raw === undefined || raw === '') {
    return { ok: true, vector: null };
  }

  if (Array.isArray(raw)) {
    // Defensive: a future extract written with `array_to_json` would arrive
    // already parsed, and silently rejecting it would look like "the corpus
    // lost its embeddings".
    const values: unknown[] = raw;
    if (!values.every((value): value is number => typeof value === 'number')) {
      return { ok: false, reason: 'embedding array contains a non-number' };
    }
    return checkWidth(values);
  }

  if (typeof raw !== 'string') {
    return { ok: false, reason: `embedding is a ${typeof raw}, not a vector literal` };
  }

  const trimmed = raw.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    return { ok: false, reason: 'embedding is not a bracketed vector literal' };
  }

  const body = trimmed.slice(1, -1);
  if (body.trim().length === 0) {
    return { ok: false, reason: 'embedding literal is empty' };
  }

  const parts = body.split(',');
  const vector: number[] = new Array<number>(parts.length);

  for (let index = 0; index < parts.length; index += 1) {
    const value = Number(parts[index]);
    if (!Number.isFinite(value)) {
      // NaN and Infinity are rejected rather than stored. pgvector refuses them
      // too, but it would refuse them mid-transaction with a message that names
      // neither the chunk nor the position.
      return { ok: false, reason: `embedding component ${String(index)} is not a finite number` };
    }
    vector[index] = value;
  }

  return checkWidth(vector);
}

function checkWidth(vector: readonly number[]): VectorParseResult {
  if (vector.length !== EMBEDDING_DIMENSIONS) {
    return {
      ok: false,
      reason: `embedding has ${String(vector.length)} dimensions, expected ${String(EMBEDDING_DIMENSIONS)}`,
    };
  }

  return { ok: true, vector };
}

/** The literal Postgres accepts for a `vector` column. */
export function toVectorText(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}
