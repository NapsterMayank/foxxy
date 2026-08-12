/**
 * platform/tx — an open transaction, carried across a module boundary.
 *
 * ===========================================================================
 * WHY THIS EXISTS: D-056, and one ESLint rule that would otherwise make it
 * impossible to obey.
 *
 * D-056 requires `practice.submitSession` to write responses, the session, the
 * XP ledger and MASTERY in one transaction. `chapter_mastery` belongs to
 * `learner`, so the executor has to reach `learner.updateMastery` — and D-056's
 * own wording is that `platform/db` exports an opaque `Executor` type for
 * exactly this, because `modules -> platform` is an allowed dependency edge.
 *
 * It is allowed in ARCHITECTURE and forbidden in ENFORCEMENT: the
 * `no-restricted-imports` rule of plan §7.4 bans `@/platform/db` from every
 * module file that is not a `*.repository.ts`, INCLUDING type-only imports.
 * That rule is right and should not be widened — it is what stops a service
 * quietly acquiring a query. So the type a service passes around cannot be the
 * drizzle executor itself.
 *
 * `TransactionToken` is that type. It is OPAQUE: it has no methods, nothing can
 * be queried through it, and the only two functions that can turn it into a
 * real executor live in `platform/db` and are importable only from a
 * repository. A service can therefore hold a transaction and hand it on, and
 * still cannot run a statement with it — which is the property the boundary
 * wanted in the first place, expressed in the type rather than in a convention.
 * ===========================================================================
 */

declare const transactionBrand: unique symbol;

/**
 * A live transaction. Obtained from a repository's `withTransaction`, passed to
 * another module's public function, and unwrapped only inside a repository.
 *
 * Deliberately unconstructible outside `platform/db`: the brand is a `unique
 * symbol` that is declared and never exported, so no caller can fabricate one
 * and no cast produces a usable value.
 */
export interface TransactionToken {
  readonly [transactionBrand]: 'open-transaction';
}
