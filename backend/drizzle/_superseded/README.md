# Superseded migrations — do not run these

Migrations `0000`-`0008`, exactly as they were applied before the collapse
(D-091), plus their hand-written down migrations and the snapshots that existed.

## They are excluded from the runner

`scripts/migrate.ts` and `drizzle.config.ts` both point at `drizzle/migrations`
and never look in here. `tests/helpers/postgres.ts` reaches this directory only
through the explicit set name `'superseded'`, and
`drizzle-snapshot-chain.test.ts` asserts that no file in here appears in the
live journal — because a superseded migration re-applied on top of the baseline
fails on "already exists" in the best case and double-applies DDL in the worst.

**Never add a migration here, and never edit one.**

## They are not archaeology — they are the oracle

`tests/integration/baseline-collapse.test.ts` applies this chain to one database
and `drizzle/migrations/0000_baseline.sql` to another, reads both schemas out of
the catalogue, and asserts they are equal: every column, every constraint
expression, every index, every trigger, the function bodies, all the comments,
the extensions, and the seeded tenant row.

That test is the only thing that makes "the baseline is equivalent to the chain
it replaced" a checked claim rather than a story. **Deleting this directory
deletes the evidence**, and the collapse becomes something we asserted.

Two differences are expected, asserted individually, and explained in that
test's header: ordinal column position, and a `DESC` / `DESC NULLS LAST`
divergence in four indexes that the collapse itself uncovered.

## Why they were collapsed

`0004`-`0007` were hand-written, so per-migration snapshots for them never
existed and could not be reconstructed — those schema states were never
committed (D-081). The chain was linked rather than gapless, which `db:generate`
tolerates and no reviewer can verify by eye. Nothing was deployed anywhere and
the repository had no commits, so collapsing was as cheap as it will ever be.
