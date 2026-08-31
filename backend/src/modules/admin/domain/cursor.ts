/**
 * =============================================================================
 * KEYSET CURSORS — opaque to the caller, checked on the way back in.
 *
 * Every admin list is ordered by `(created_at DESC, id DESC)`, the same shape
 * the notifications list already uses. A cursor is the ordering columns of the
 * row the last page ended on.
 *
 * NOT AN OFFSET. `OFFSET 5000` makes Postgres walk five thousand rows to throw
 * them away, and it double-counts or skips whenever a row is inserted between
 * two page requests — which on an audit log being written by the very screen
 * reading it is not a corner case.
 *
 * -----------------------------------------------------------------------------
 * OPAQUE, AND base64url IS NOT WHY.
 *
 * The encoding is not a secret and is not pretending to be: anyone can decode
 * it. What "opaque" buys is that no CLIENT is written against its contents, so
 * the ordering columns stay changeable. The moment a caller parses a cursor,
 * the server's sort order becomes public API.
 *
 * It is therefore VALIDATED rather than trusted. A cursor arrives from a caller
 * who can send anything, and it lands in a `WHERE` clause — so it is parsed
 * into a real Date and a real uuid, and anything else is refused. The values
 * are then passed as bound parameters, never interpolated.
 * =============================================================================
 */
import { ValidationError } from '@/platform/errors/index';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Cursor {
  readonly createdAt: Date;
  readonly id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.createdAt.toISOString()}|${cursor.id}`, 'utf8').toString('base64url');
}

/**
 * @throws ValidationError when the cursor is not one this server produced.
 *
 * A 400 rather than "start from the beginning": silently ignoring a malformed
 * cursor makes a paging bug look like a data bug, and the caller pages for ever
 * without ever being told why.
 */
export function decodeCursor(raw: string): Cursor {
  const invalid = (): never => {
    throw new ValidationError('That page cursor is not valid.', {
      message: 'admin.decodeCursor: cursor did not decode to <iso>|<uuid>',
    });
  };

  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    return invalid();
  }

  const separator = decoded.indexOf('|');
  if (separator === -1) return invalid();

  const iso = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  if (!UUID.test(id)) return invalid();

  const createdAt = new Date(iso);
  // `new Date('nonsense')` is an Invalid Date rather than a throw, and an
  // Invalid Date passed to the driver becomes `NULL` — which silently matches
  // nothing and reads as "no more pages".
  if (Number.isNaN(createdAt.getTime())) return invalid();

  return { createdAt, id };
}

/**
 * The cursor for the page just returned, or null when it was the last one.
 *
 * `rows.length < limit` IS THE END CONDITION, which means a full final page
 * costs one extra empty request. The alternative — asking for `limit + 1` and
 * discarding — is one more row per page for ever to save one request per list,
 * and these lists are read by one operator rather than by every learner.
 */
export function nextCursor(rows: readonly Cursor[], limit: number): string | null {
  if (rows.length < limit) return null;
  const last = rows[rows.length - 1];
  return last === undefined ? null : encodeCursor(last);
}
