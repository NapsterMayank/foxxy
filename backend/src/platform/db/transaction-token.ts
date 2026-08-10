import type { TransactionToken } from '../tx/index';
import type { DbExecutor } from './client';

/**
 * The two ends of D-056's opaque executor.
 *
 * `wrapExecutor` is called by the repository that OPENS a transaction;
 * `unwrapExecutor` by any repository that is handed one. Both live here, in
 * `platform/db`, because that is the only place ESLint permits a module file to
 * import from — a service can hold a `TransactionToken` and can do nothing with
 * it, which is the whole point (see `platform/tx/index.ts`).
 *
 * The casts are the seam. They are contained to these six lines and are why
 * nothing else in the codebase needs one.
 */

export function wrapExecutor(executor: DbExecutor): TransactionToken {
  return executor as unknown as TransactionToken;
}

/**
 * The executor inside a token, or `undefined` when there is no token.
 *
 * Returning `undefined` rather than throwing on absence is deliberate: every
 * repository method that accepts a token also has to work WITHOUT one, because
 * most callers are not inside a transaction. `unwrapExecutor(token) ?? db` is
 * the whole idiom, and it reads as what it is.
 */
export function unwrapExecutor(token: TransactionToken | undefined): DbExecutor | undefined {
  return token === undefined ? undefined : (token as unknown as DbExecutor);
}
