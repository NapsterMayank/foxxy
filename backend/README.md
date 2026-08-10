# Foxxy — Backend

Node 22 · TypeScript · Fastify · Postgres 16 + pgvector · Drizzle · Valkey.

The specification lives in `../docs/00-ARCHITECTURE.md` and
`../docs/01-BACKEND-IMPLEMENTATION-PLAN.md`. Those two documents are the
contract; this README only tells you how to run what they describe.

**What exists today:** build-order steps 1 to 5 — the repository and its
tooling, the platform layer, the identity schema and its migrations, the
authorization boundary, and the identity module in full.

The platform layer has also had a resilience hardening pass
(`docs/04-RESILIENCE-PLAN.md` sections 3, 4, 5, 7, 8, 11, 12): four bulkheaded
connection pools, one validated timeout policy, circuit breakers and
concurrency limits on every external port, three health endpoints, and
graceful shutdown.

---

## Running it

```bash
npm install
cp .env.example .env          # every variable is documented in that file
docker compose -f docker/compose.yml --env-file .env up -d
npm run db:migrate
npm run dev                   # http://localhost:4000/health/live
```

`docker compose` brings up Postgres 16 with pgvector and Valkey, both with
healthchecks and named volumes (`foxxy_postgres_data`, `foxxy_valkey_data`).

**Postgres is published on 5433, not 5432.** A natively installed Postgres
commonly already holds 5432, and the failure mode is a baffling "password
authentication failed" against the wrong server rather than a connection
refused. Override with `POSTGRES_PORT` if you want it elsewhere.

The server reads its environment exactly once, at boot, and **refuses to start
if a required variable is missing** — it prints which ones and exits 1. There is
no code path that discovers a missing variable later.

## Scripts

| Script | Does |
|---|---|
| `npm run dev` | Watch-mode server on port 4000 |
| `npm run build` | Type-emit to `dist/`, then rewrite path aliases |
| `npm start` | Run the built server |
| `npm test` | Everything — unit plus integration |
| `npm run test:unit` | Fast half only; no Docker needed |
| `npm run test:integration` | Real Postgres in a container, via testcontainers |
| `npm run test:coverage` | Coverage, with the section 9.4 floors enforced |
| `npm run type-check` | `tsc --noEmit` |
| `npm run lint` / `lint:fix` | ESLint, including the boundary rules |
| `npm run db:generate` | Generate a migration from the Drizzle schema |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:studio` | Drizzle Studio |

## Folder structure

```
src/
├─ app/          composition root — the ONLY place adapters are chosen
│  ├─ server.ts     builds the Fastify instance, registers plugins and health
│  ├─ health.ts     /health/live, /health/ready, /health/deps
│  ├─ shutdown.ts   SIGTERM: readiness 503, drain, close pools, exit 0
│  ├─ container.ts  builds and injects every dependency
│  └─ plugins/      request id, error handler, CORS
│
├─ modules/      ALL business logic. Nothing here yet.
│                Each module exposes exactly one public file, index.ts.
│
├─ platform/     infrastructure. NO business rules.
│  ├─ config/      reads process.env once, validates, freezes, or exits
│  ├─ errors/      the AppError hierarchy (message vs safeMessage)
│  ├─ logger/      pino, JSON, redaction configured centrally
│  ├─ db/          four bulkheaded pools, withTransaction, schema/, probe
│  ├─ authz/       THE access boundary. 100% coverage, enforced.
│  ├─ cache/       CachePort + Valkey adapter + in-memory fake + guard
│  ├─ http/        outbound client with timeout, jittered retry, breaker
│  ├─ clock/       now() and sleep(), plus fixed/recording fakes
│  ├─ id-gen/      uuid(), plus a counter fake
│  ├─ circuit-breaker/  generic breaker: closed / open / half-open
│  ├─ concurrency/ max in-flight per port; rejects, never queues
│  ├─ retry/       exponential backoff WITH jitter; refuses non-idempotent
│  ├─ resilience/  composes limit -> breaker -> timeout, one guard per port
│  ├─ llm/ embed/ payments/   interfaces + guards; adapters land later
│  └─ mail/        interface + dev stdout adapter + recording fake + guard
│
└─ shared/       types and constants imported by backend AND frontend.

tests/
├─ integration/  real database, real HTTP, fake external APIs
└─ helpers/      test database setup

drizzle/
├─ migrations/   generated forward migrations. NEVER edit a merged one.
└─ down/         hand-written rollbacks, one per migration, same number.
```

**Why the shape:** dependencies point one way — `app` → `modules` → `platform`
and `shared`. `platform/` never imports `modules/`. `shared/` imports nothing.
A module's `domain/` folder imports nothing outside its own module, which is
what makes business logic testable with no database and no clock.

## The boundary rules, and how they were verified

Four rules are enforced mechanically by `eslint.config.js`:

1. **Module public surface** — nothing may import `modules/<name>/<anything>`
   except `index.ts`.
2. **Module escape** — from inside a module, anything outside it is imported
   through the `@/` alias, never a relative path. This makes every cross-module
   edge greppable: search `@/modules/` and you have the dependency graph.
3. **`process.env`** — readable only inside `src/platform/config`.
4. **The database client** — importable only from `*.repository.ts` (and from
   `app/container.ts`, which is what builds the handle).

Plus: no default exports, no `any`, explicit return types on exported functions.

**A rule that has never failed is not known to work.** Each one above was
verified by writing a file that breaks it, confirming `npm run lint` exits
non-zero with the intended message, and confirming the legitimate equivalent
still passes. That exercise caught two rules that were silently enforcing
nothing:

- `no-restricted-imports` patterns are matched with **gitignore-style globs**,
  not minimatch. The extglob `../*/!(index)` matched nothing at all — a leading
  `!` is a negation, not "not".
- A gitignore pattern that matches a directory also matches everything beneath
  it, so `../*/*` swallowed the legitimate `../../platform/errors/index`. A rule
  with false positives gets switched off, which is worse than one that is
  narrow.

Repeat the exercise whenever a rule is added or a directory moves.

## Testing

Three levels, per section 9.1: unit (`domain/`, pure, milliseconds), service
(a use case with fake ports and a **real** database), and integration (a real
HTTP request through the whole stack).

**The database is never faked.** Service and integration tests run against a
real Postgres 16 + pgvector in a container. A faked database hides exactly the
bugs worth finding — constraint violations, transaction behaviour, and the gap
between what a query means and what SQL does. The language model, embedding
service, mailer and payment provider *are* faked: they are slow, cost money and
are non-deterministic.

Coverage floors (section 9.4) are enforced by `vitest.config.ts`:

| Area | Floor |
|---|---|
| `platform/authz/` | **100%** — an access-control gap is an incident, not a bug |
| `modules/*/domain/` | 95% |
| `modules/*/*.service.ts` | 80% |
| Everything else | 70% |

The per-path floors were themselves verified to fail when breached, so the
100% authz gate is real rather than decorative.

## Migrations

Generated by `drizzle-kit`, then **reviewed by hand before committing**. The
first migration needed a hand edit: drizzle-kit does not emit extension DDL, so
`CREATE EXTENSION citext` / `vector` was prepended — without it the `citext`
column type does not exist and the migration fails on a fresh database.

- Never edit a migration that has been merged. Write a new one.
- Never drop a column in the same release that stops using it.
- Every migration runs forward **and** backward. Drizzle has no down-migration
  support, so rollbacks are hand-written in `drizzle/down/` under the same
  number, and `tests/integration/identity-migration.test.ts` proves that
  `0000_identity` applies, rolls back to an empty schema, and re-applies.
