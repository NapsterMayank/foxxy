# Decision Log

Every decision taken during implementation that the plans did not specify, or that contradicts what they say.

**Rule: an entry is added the same day the decision is made.** If a decision contradicts a plan document, that document is patched too, and the entry records why. Undocumented drift is how the previous codebase became unmaintainable.

Status key: **Active** · **Superseded** · **Needs review** (a decision that has not yet been taken, or has been agreed but not implemented)

---

## Foundation phase — 7 August 2026

### D-001 · `assertCanAccess` is produced by a factory
**Status:** Active (approved)
Plan section 7 specifies `assertCanAccess(actor, action, resource): void`, and separately requires link status to be read at query time by an injected function. A fourth parameter would break the stated signature; an async function would break the `void` return.
**Decision:** `createAccessGuard({ readLinkStatus })` returns an object whose `assertCanAccess` keeps exactly the specified three-argument signature. The reader is synchronous, so the caller must load link status immediately before calling — which is what "at query time" means.
**Consequence:** callers fetch link status themselves. `container.ts` currently passes a placeholder returning `null`; remove it when the `parent` module lands.
**Plan patched:** yes, section 7.

### D-002 · Resource is a discriminated union
**Status:** Active
The plan names actors and outcomes but never a resource shape.
**Decision:** `student-data` (carrying a scope) · `account` · `subscription` · `content`. Ownership checks for "own profile" collapse into a single branch covering both roles.

### D-003 · Content is read-only over the API
**Status:** Active
The plan allows any authenticated user to access content without qualifying the action.
**Decision:** `read` allowed, `write` denied. Nothing in the product authors curriculum through the API. Relax later if that changes.

### D-004 · Default-deny implemented with `switch` and `default`
**Status:** Active
An exhaustive narrowing chain makes the final `throw` unreachable to the type checker, leaving that line permanently uncovered — a 100% coverage gate that cannot be satisfied.
**Decision:** a `switch` with `default: break`, so the throw is genuinely reachable. A test drives it with a deliberately malformed resource kind.

### D-005 · ESLint `no-restricted-imports` uses gitignore globs, not minimatch
**Status:** Active — **important**
The originally written pattern `'../*/!(index)'` matched **nothing**: a leading `!` is a negation in gitignore syntax, not "not". The rule read as authoritative while enforcing zero. Correcting it to `'../*/*'` then produced a false positive, because a gitignore pattern that matches a directory matches everything beneath it.
**Decision:** the concern is split into `MODULE_BOUNDARY_PATTERNS` (alias and root forms) and `MODULE_ESCAPE_PATTERNS` (`../../**`, `../*/*`, applied only inside `src/modules/`). The teachable rule: **from inside a module you reach outside it through `@/` only.**
**Consequence:** this is the exact failure that silently disabled enforcement in the previous codebase. Every boundary rule was then verified by writing a violating file, confirming lint fails, and deleting it. Repeat that whenever a rule is added or a directory moves.

### D-006 · Coverage gates were proven to fail before being trusted
**Status:** Active
The authz threshold was temporarily raised to 100.0001% to confirm vitest actually errors. It does. The gate is real, not decorative. Apply the same check to any new threshold.

### D-007 · Three development dependencies beyond the plan
**Status:** Active
`tsx` — the only practical way to run TypeScript for dev and migrations. `tsc-alias` — `tsc` never rewrites path aliases, so `@/*` would not resolve in `dist/`. `vite-tsconfig-paths` — the same alias problem, for vitest.
No runtime dependency was added beyond the plan's list.

### D-008 · Extensionless imports; TypeScript target ES2022
**Status:** Active
drizzle-kit transpiles the schema to CommonJS and cannot resolve `./x.js` to `x.ts`. Its bundled esbuild also rejects `es2023`.
**Decision:** source imports are extensionless; `tsc-alias --resolveFullPaths` appends `.js` at build time for plain Node ESM.

### D-009 · Postgres publishes on port 5433
**Status:** Active
A native Postgres already holds 5432 on the development machine. The symptom was `password authentication failed` against the wrong server rather than a refused connection — a genuinely confusing failure.
**Decision:** the container publishes 5433. Documented in `.env.example` and the backend README.

### D-010 · vitest pool set to `threads`
**Status:** Active
The default `forks` pool emits an unhandled `kill EPERM` during teardown on Windows with Node 22 — **after** a green run, so a passing suite looks broken.

### D-011 · `app/container.ts` is exempt from the database-import rule
**Status:** Active — watch this
The composition root builds the handle that repositories receive, so it must import the client. The exemption is narrow and by filename.
**Consequence:** if that exemption list ever grows beyond one entry, the boundary has stopped meaning anything. Treat growth as a design smell, not a configuration task.

---

## Identity module — 7 August 2026

### D-012 · Link codes are stored in the cache, not in a table
**Status:** **Resolved by D-021 (table) and D-033 (service repointed)** — 8 August 2026
`parent_child_links.parent_user_id` is `NOT NULL`, but the specification has the student issue a code *before* any parent is known. The schema and the flow contradict each other.
**Implemented:** issued codes live in `platform/cache` under a 15-minute expiring key, which makes "one active code per student" and the expiry properties of the store. The code is copied onto the link row on submit.
**Problem:** a cache restart silently invalidates every outstanding code. The parent enters a code their child has just read aloud and is told it is invalid — an intermittent, unreproducible failure in the onboarding funnel.
**Agreed fix:** add a `link_codes` table with a nullable parent reference. One migration, no interface change.
**Plan patched:** yes, section 4.

### D-013 · `EMAIL_NOT_VERIFIED` carried as a `reason` field
**Status:** Active
`AppError.code` is closed over the platform codes and `ForbiddenError.safeMessage` is fixed. Rather than widen platform code that is architect-owned and at 100% coverage, the module error overrides `toClientPayload()` to add a narrow `reason` field. The contract was updated to match.

### D-014 · Revoke authorisation lives in the query, not in authz
**Status:** Active
`platform/authz` covers a parent **reading** child data. Link **membership** is a different question, and no rule expressed it.
**Decision:** revoke enforces participation in the `UPDATE` statement's `WHERE` clause rather than bending an existing rule to a case it was not written for.

### D-015 · Verification redirects to an origin-derived URL
**Status:** **Resolved by D-022** — `APP_URL` and `API_URL` are required config, and tests assert the redirect is built from `APP_URL` rather than the request host or the CORS list (8 August 2026)
Success redirects 302 to `corsOrigins[0] + /onboarding`; a bad token returns 400 JSON. No `APP_URL` or `PUBLIC_API_URL` variable existed, so `apiBaseUrl` is derived from host and port.
**Consequence:** this breaks the moment a reverse proxy fronts the service. Add explicit configuration before deploying behind one.

### D-016 · Cookie `secure` is disabled in development
**Status:** Active
A secure cookie is silently dropped over local HTTP, which makes login appear to succeed and then fail. `secure` is true everywhere except `NODE_ENV=development`.

### D-017 · `fastify-type-provider-zod` not used
**Status:** Active
Validation runs through a `parseInput` helper at each handler. Keeps handlers small and the dependency count lower. Handlers are 5 to 11 lines.

### D-018 · Common-password list is ~370 entries, not 10,000
**Status:** **Resolved by D-036** — the full published top-10,000 is vendored (8 August 2026)
Currently the published top band plus normalisation (lower-casing, stripping leading and trailing non-letters, reversing leetspeak), so `P@ssw0rd123!` is caught by the entry `password`.
**Agreed fix:** vendor the full corpus. Roughly 75 kB is not a real cost against credential stuffing, and the loader is already size-agnostic — a one-file change. **Done:** it was indeed one file plus one import; `password.ts` was unchanged apart from its comments.

### D-019 · `sessions.last_used_at` is written from the injected clock
**Status:** Active — defect found by tests
The column defaulted to the database clock while sliding renewal compared against the injected clock. In production the two agree to the millisecond and nothing is ever noticed; renewal would have degraded silently under any clock skew.

### D-020 · One shared testcontainer via global setup
**Status:** Active
Four parallel files each starting a container failed the run with "Failed to connect to Reaper" while every individual test passed.
**Decision:** one container in `globalSetup`, with a fresh database per file. The migration test drops all tables, so per-file isolation is correctness rather than tidiness. Suite time went from 27s to 10.6s.

---

## Platform hardening pass — 8 August 2026

Resilience plan sections 3, 4, 5, 7, 8, 11 and 12, plus the two schema and
configuration items carried as open decisions.

### D-021 · `link_codes` retires the previous code inside the insert transaction
**Status:** Active — resolves **D-012**
The partial unique index on `student_user_id WHERE consumed_at IS NULL` is what enforces "one active code per student". It also means a student who asks for a second code hits a constraint violation unless the previous one is retired first.
**Decision:** `issueLinkCode` marks any unconsumed row consumed and inserts the new one in ONE transaction. Retiring means `consumed_at = now`, never `DELETE` — the row is the audit record of which code produced which link, and the partial index ignores it once spent.
**Why one transaction and not two statements:** a crash between them leaves the student with no active code and a row that still blocks every future insert. Permanently, and silently, and only for that one student.
**Consequence:** the identity module is untouched. `issueLinkCode`, `consumeLinkCode` and `findActiveLinkCodeForStudent` exist on the repository, are tested against a real Postgres including the two-parents-race case, and are waiting for the service to be repointed off the cache.
**Plan patched:** no — plan §4 already specified this table and this index.

### D-022 · `APP_URL` and `API_URL` are required configuration
**Status:** Active — resolves **D-015**
Both origins were derived, and both derivations were wrong in the same deployment. `apiBaseUrl` came from `HOST` + `PORT`; `HOST` is a *bind* address, so behind a proxy the verification link mailed to a new user pointed at `0.0.0.0` or a container IP. `appBaseUrl` was `corsOrigins[0]` — an allow-list entry that happens to be first, so adding a staging origin at the front would have redirected every production signup to staging.
**Decision:** both are required variables, validated as absolute http(s) origins with no path, trailing slashes stripped. Required rather than defaulted: a deployment that forgets them fails at boot, which is a far cheaper failure than a broken onboarding funnel discovered from support tickets.
**Consequence:** three test fixtures gained two variables. `app/routes.ts` reads `config.urls`; the identity module's interface did not change.

### D-023 · `code_expires_at` is dropped in the same release that stops reading it
**Status:** Active — a deliberate, bounded exception
Plan §4, rule 3 says never drop a column in the release that stops using it. That rule protects a rolling deploy where old and new code run at once.
**Decision:** dropped now anyway. The service has never been deployed, the table is empty everywhere it exists, and expiry is a property of the code — keeping a second copy of one lifetime is a second thing that can disagree with the first.
**Consequence:** this exception expires at the first production deploy. After that, rule 3 applies without qualification. `link_code` itself STAYS, as the historical record of which code created a link.

### D-024 · `/health` survives as a deprecated alias for `/health/live`
**Status:** Active
§8 replaces `/health` with three endpoints. Something is always pointed at `/health` — a compose file, a dashboard, an uptime monitor — and removing it in the same change that introduces the replacement means the outage is caused by the fix.
**Decision:** `/health` remains, aliasing **liveness** and nothing else. Aliasing readiness would silently upgrade every existing probe into one that touches the database, introducing the exact trap §8 exists to prevent, in the change whose purpose is to prevent it.
**Consequence:** remove it once the deployment manifests point at `/health/live`. A test asserts the two responses are identical, so it cannot drift into something else.

### D-025 · The concurrency limiter sits OUTSIDE the circuit breaker
**Status:** Active — **important**
Composition order is `limit → breaker → timeout → call`, and the first arrow is a real decision.
**Decision:** an overflow rejection never reaches the breaker. Overflow means *we* are sending too much; it says nothing about the dependency's health. Counting it would open the circuit during a traffic spike and convert a busy minute into a self-inflicted outage — and it would do so precisely when the system is under most load.
**Consequence:** the breaker is outside the timeout for the mirror-image reason: a timeout is the failure mode §5 exists for, because a dependency that is *slow* rather than down is the expensive one. Both orderings have a test.

### D-026 · `cache` and `http` carry concurrency limits §3.3 does not name
**Status:** Active
§3.3 caps four ports. Two more are guarded today.
**Decision:** `cache` 100 and `http` 50, generous enough that normal traffic never reaches them. A limit nobody reaches costs nothing; a port with no limit at all is the one that takes the process down, and a uniform guard shape means no port can be wired up with a bulkhead missing.
**Plan patched:** no — the §3.3 table states the four that matter, and these two are infrastructure defaults rather than policy.

### D-027 · Waiting is a port: `Sleeper` in `platform/clock`
**Status:** Active
§11 requires the retry delay *sequence* and the jitter *bounds* to be asserted, and §9.5 bans `sleep` in a test outright. Both are impossible if backoff waits on a bare timer.
**Decision:** `Sleeper` joins `Clock`. Production waits on a timer; `RecordingSleeper` records the requested delay and advances a `FixedClock` by it. Assertions are on what the code *asked* to wait, and the retry suite runs in 11ms.
**Consequence:** the jitter strategy is *equal jitter* — the delay is always in `[base/2, base]`. Full jitter de-synchronises marginally better but permits a near-zero wait after a failure, which is the opposite of what backoff is for.

### D-028 · `statement_timeout` is a connection parameter, not a `SET`
**Status:** Active
Each pool passes `options: '-c statement_timeout=…'` rather than issuing `SET statement_timeout` after connecting.
**Decision:** a `SET` can be missed — a connection created during a reconnect storm, or handed out before the setup query ran, would silently have no timeout at all. As a startup parameter it is a property of the connection rather than something that must be applied to it. The one query that runs forever is exactly the one on the connection nobody could account for.
**Consequence:** the `ai` pool gets 5s and the others 10s, asserted against a real Postgres including a query that is actually cancelled.

### D-029 · The four unbuilt ports are guarded at the interface, not the adapter
**Status:** Active
`llm`, `embed`, `mail` and `payments` are interfaces with no implementation yet.
**Decision:** `createGuardedLlm`, `createGuardedEmbed`, `createGuardedMail` and `createGuardedPayments` exist now and are tested with fakes. Whoever builds an adapter passes it through the wrapper at the composition root and inherits the breaker, the limit and the timeouts.
**Why not wait:** "we'll add the breaker when we add the adapter" is how the least reliable dependency in the system — §2 rates the LLM API "High" likelihood — ends up being the only one without protection.
**Two details worth keeping:** a streamed LLM response holds its concurrency slot for the *lifetime* of the stream (`limiter.acquire()`, not `run`), because releasing at the first token would let unbounded open streams sit behind a limit of 20. And `payments.verifyWebhook` is deliberately **not** guarded: it is a local HMAC comparison, and letting an open circuit stop us verifying signatures would turn a provider outage into a security failure.

### D-030 · `container.db` aliases the `auth` pool
**Status:** Active — watch this
The container exposes all four pools as `pools`, and keeps `db` pointing at `pools.auth`.
**Decision:** identity is the auth concern, and §3.1 is explicit that its pool must never be starved. The alias delivers the bulkhead to the only module that exists today without editing that module, which this pass was scoped out of.
**Consequence:** `db` is a convenience that will become misleading the moment a second module lands. When `learner` or `content` arrives, each module should be handed its pool explicitly from `app/routes.ts` and this alias should go.

### D-031 · Readiness probes through the `core` pool and checks migration history
**Status:** Active
**Decision:** the probe runs `select 1` and counts `drizzle.__drizzle_migrations`, both on `core`. Probing through `auth` would let a health checker consume the one pool that must never be starved.
**The migration half is the part that is easy to omit:** a process connected to an empty database is "reachable" and completely unable to serve a request. Rolling a deploy in front of an unmigrated database is how a green readiness check routes traffic into 500s.
**Defect found by the test:** the two queries were originally started concurrently and the second awaited only if the first succeeded — so with the database down, every readiness probe produced an unhandled rejection. They are sequential now, which also costs one connection instead of two.

### D-032 · The breaker can classify a returned VALUE as a failure
**Status:** Active
`execute(fn, { isFailureResult })`.
**Decision:** the HTTP adapter resolves with `{ status: 503 }` rather than throwing. Without result classification the breaker would treat that as a success and would never open on the exact failure it exists for. `4xx` — 429 included — is not counted: a malformed request is our defect, and counting our own 400s would open the circuit for every caller because one caller sent rubbish.

---

## Identity hardening pass — 8 August 2026

Open items 1-4, closing D-012, D-015 and D-018.

### D-033 · Nothing whose loss changes what a user may do lives in a cache
**Status:** Active — **resolves D-012**, closes open item 4
`generateLinkCode` and `submitLinkCode` now call `issueLinkCode`, `consumeLinkCode` and `findActiveLinkCodeForStudent`. The deprecated `codeExpiresAt` parameter is gone from `upsertPendingLink`, and the cache-key helpers are deleted rather than left dormant.
**The application-level "one active code per student" logic was REMOVED, not ported.** It used to read the student's current code out of the cache and delete it before issuing a new one. That is a check-then-write, and the database now expresses the same rule as a partial unique index, so keeping the application copy would have been a slower way of being wrong: two concurrent issue requests would both pass the check. `issueLinkCode` retires and inserts in one transaction, and a genuine race ends in a 23505 that the repository translates into a 409 telling the caller to try again.
**Consequence:** `platform/cache` is now used for rate-limit counters and nothing else, and the standing rule this episode produced is the entry title. A counter is a fair thing to lose on a restart — a user's ability to finish onboarding is not.
**Two things the tests pin that the code alone does not say:** a simulated cache restart (`cache.close()`, then submit) no longer invalidates an outstanding code — that is the regression the whole change exists to prevent — and two parents racing on one code produce exactly one link.

### D-034 · The rate-limit fallback is per-instance, and says so out loud
**Status:** Active — closes open item 2
When `cache.incr` rejected, `consume` rejected, and login returned 500. One unreachable cache container disabled authentication for the entire product (§2, F5). The circuit breaker made that failure fast; fast failure is still failure.
**Decision:** on any cache error the counter moves into this process for that request. The fallback is deliberately weaker — per instance, so N instances admit up to N x the limit, and the counts vanish on restart. **Degraded rate limiting beats no authentication**, and the limit was never the only credential-stuffing defence: Argon2id, the identical-response rules and the (now complete) common-password corpus are all untouched by a cache outage. The alternative trade — fail closed — hands an attacker a total authentication outage in exchange for taking down one cache container.
**Every activation logs at `warn` AND increments `identity.rate_limit.in_process_fallback`.** A silent fallback is a silent security downgrade; the point of the noise is that somebody notices and fixes the cache. `MetricsSink` is a module-local interface because no metrics port exists yet — when one lands, the composition root passes it in and nothing else changes.
**A defect the work surfaced:** if `incr` succeeded and `expire` then failed, the counter existed with NO TTL — a lockout that never ends, for exactly the users unlucky enough to be first in a window during a partial outage. The key is now deleted and the attempt counted in process.
**Bounded on purpose:** the in-process map caps at 50,000 keys and evicts expired windows first. An unbounded map hands an attacker a memory-exhaustion lever precisely when the system is already degraded.

### D-035 · The origin check is an `onRequest` hook, and a missing Origin is a rejection
**Status:** Active — closes open item 3
Plan §6.10 pairs `sameSite=lax` with "an origin check on state-changing requests". Only the cookie attribute existed. The two are not redundant: `lax` is `lax` rather than `strict` so the emailed verification link arrives authenticated, which means the cookie IS sent on a top-level cross-site request.
**Decision:** one shared hook in `src/app/plugins/origin-check.ts`, registered on the server, covering POST, PUT, PATCH and DELETE. It lives in `app/plugins` and not in `identity` because a CSRF defence each module opts into is one the twelfth module forgets.
**`onRequest`, not `preHandler`:** the plan's word "preHandler" describes the shape — one hook, every route, written once — and `onRequest` runs before the body is parsed and before any authentication, so a forged request costs this process nothing. The visible consequence is that an unauthenticated cross-site POST now answers 403 rather than 401; the order is deliberate, since the CSRF verdict does not depend on who the caller claims to be.
**A missing Origin is a REJECTION.** "No header, so it cannot be a browser, so allow it" is precisely the reasoning an attacker relies on. `Referer` is accepted as a fallback; the literal string `null` is not an origin.
**The webhook exemption** (`/api/v{n}/webhooks/`) exists because payment providers post server-to-server with no browser and therefore no Origin — a check there would 403 every real payment event while the provider retried for hours. The compensating control is HMAC signature verification, which is strictly stronger than an origin hint, and which `platform/payments` deliberately keeps outside the circuit breaker so an outage can never stop us verifying it (D-029). The exemption is a narrow prefix, asserted by tests against five near-miss paths.
**Allowed origins come from config** — the CORS allow-list plus `APP_URL`, never a literal.

### D-036 · The full corpus is one template literal, not a 10,000-element array
**Status:** Active — **resolves D-018**, closes open item 1
The published SecLists top-10,000 (`Passwords/Common-Credentials/10k-most-common.txt`) is vendored verbatim in `domain/common-passwords.data.ts`; the pre-existing hand-written list is kept alongside it for the product- and region-specific entries a global frequency corpus does not carry (`foxxy…`, Indian city and cricket words). Both fold into one `Set` at module load, so lookup is O(1) and duplicates cost nothing.
**Why a string rather than an array literal:** 10,000 array elements are 10,000 separately type-checked expressions, and tsc, ESLint's type-aware rules and the v8 coverage instrumenter each pay for every one. One string split once is one expression. The lookup budget is asserted rather than assumed — 20,000 lookups, twice the corpus size, complete in single-digit milliseconds, which an accidental array scan could not do.
**The list is deliberately not curated.** It is distilled from real breach data and some entries are crude; editing it for taste would quietly weaken it, and the only thing it is ever compared against is a password the user is being told not to use.
**A gap now written down rather than assumed away:** normalisation strips leading non-letters BEFORE reversing leetspeak, so a substitution in the FIRST character is not seen through — `8utterfly` is accepted. The order cannot be reversed (`hello2024` would become `helloaoaa` and the stripping would never fire), so this is a real, bounded limitation with a test asserting it.

---

## learner + content schema — 9 August 2026

Plan §4 "learner" and "content", plus the three one-way doors in PROGRESS.md §8.
Schema, migration `0002_learner_content`, fixtures and pool assignment. No
module code.

### D-037 · The curriculum vocabulary lives in `shared/constants`, not beside the tables
**Status:** Active
`learner.chapter_mastery` references `content.chapters`, and `content` needs the
grade list — so a constant defined in either schema file makes the pair a cycle.
Under drizzle-kit's CommonJS transpilation that is not a warning but a
temporal-dead-zone crash at generate time (`Cannot access 'GRADES' before
initialization`), which is how it was found.
**Decision:** `GRADES`, `LANGUAGES`, `DIFFICULTIES`, `BLOOM_LEVELS`,
`OPTIONS_PER_QUESTION`, `DISTRACTORS_PER_QUESTION` and `EMBEDDING_DIMENSIONS`
live in `src/shared/constants/curriculum.ts`. The schema files import them by
relative path (drizzle-kit does not resolve the `@/` alias).
**The larger reason, which outlives the cycle:** modules cannot import
`platform/db` at all (§7.4, ESLint-enforced). A constant that only exists beside
the tables is a constant every module re-declares, and a re-declared list drifts
from the CHECK constraint enforcing it. One declaration now feeds both the
constraint and the Zod contract.

### D-038 · The database cannot reject an integer grade — only the Zod contract can
**Status:** Active — **important, and it contradicts what was first written**
§8.2 requires "grade `6` as a number is rejected", and the first draft of both
the schema comment and the migration header claimed the text column delivered
that. A test proved otherwise: `insert into students (...) values (..., 6)` with
a bare integer literal SUCCEEDS and stores `'6'`, because Postgres has an
assignment cast from `integer` to `text` and applies it silently. node-postgres
arrives at the same place by another road, sending a JavaScript `6` as an
untyped parameter that Postgres infers as text.
**Decision:** the split is stated explicitly everywhere it matters. The database
owns the VALUE domain — the CHECK refuses `'5'`, `'13'`, `'05'`, `'6 '`,
`'Class 6'` on every write path in all three tables. The learner module's Zod
contract owns the TYPE, and it is the ONLY thing that can enforce §8.2's rule.
**Consequence:** a test asserts the coercion rather than hiding it, so nobody
reads the CHECK, concludes the case is covered, and deletes the contract. The
claim was wrong in three files before a test was written against it — which is
the argument for §9.2 in one incident.

### D-039 · `options` is ONE CHECK, written as a CASE, not an AND chain
**Status:** Active
Two defects, both found by tests, both invisible by inspection.
**Postgres does not guarantee the evaluation order of `AND`.** Written as
`jsonb_typeof(options) = 'array' and jsonb_array_length(options) = 4`, an
`options` value of `{"a":1}` produced the raw error `cannot get array length of
a non-array` instead of a named constraint violation — the planner is free to
evaluate the right operand first. `CASE` is the only construct that guarantees
short-circuiting.
**Two constraints meant an ambiguous message.** A three-option question could be
refused by either the shape check or the emptiness check, and it happened to be
refused by the emptiness one, so a test asserting "rejected for having the wrong
number of options" failed while the database behaved perfectly.
**Decision:** one constraint, `questions_options_check`, a single CASE covering
array-ness, length 4 and no empty-string element. `distractor_misconceptions`
uses the same form.
**Not expressible, and therefore a module rule:** "all four options are
DISTINCT" needs aggregation, and a CHECK may not contain a subquery. The content
module owns it.

### D-040 · `rag_chunks.search_vector` is GENERATED, breaking the import mapping on purpose
**Status:** Active
`rag_chunks` is shaped so the ~16,000-row import from `rag_content_chunks` is a
column mapping rather than a transform — a transform is a place for 16,000 rows
to be quietly corrupted. Every shared column keeps the source name, type and
default. `search_vector` is the one deliberate exception.
**Decision:** `GENERATED ALWAYS ... STORED`, so it can never be written and the
import must not map it. A hand-maintained tsvector goes stale the first time
someone edits `chunk_text` and forgets, and a stale tsvector does not fail — the
chunk simply stops appearing in keyword search, forever, silently. Regenerating
16,000 rows costs seconds.
**Two details inside the expression:** the configuration is chosen by a CASE on
`language` ('simple' for Hindi, which has no Postgres stemmer; 'english'
otherwise), and heading fields are `setweight`ed 'A' above the body's 'B'. Both
`to_tsvector` calls use the two-argument form with a literal configuration,
which is IMMUTABLE and therefore legal in a generated column; the one-argument
form depends on a session GUC and is not.

### D-041 · HNSW m = 16, ef_construction = 128 — and ef_search is the setting that will bite
**Status:** Active
**Decision:** `m = 16` (pgvector's default) is ample graph connectivity at
16,000 rows, and raising it costs memory on every query for recall this corpus
does not need. `ef_construction = 128` doubles the default because build cost on
16,000 rows is seconds — effectively free — while the recall it buys is
permanent and cannot be added later without a rebuild.
**The measured finding, on pgvector 0.8.6:** an HNSW scan returns no more rows
than `ef_search`, whose default is 40. §8.4 asks for the top 50. Forced onto the
HNSW plan, `ef_search = 40, limit 50` returned **40** rows and `ef_search = 100`
returned **50**. Left at the default, retrieval silently receives 40 candidates
where it asked for 50, and that reads as "the corpus is thin" rather than as a
misconfiguration.
**Also measured, and the reason not to trust the above too far:** at seed scale
the planner does not choose HNSW for a FILTERED query at all — it bitmap-scans
`rag_chunks_grade_subject_idx` and sorts exactly, which is both faster and
perfectly accurate. So the HNSW path is untested by any small-corpus query, and
the filtered-recall behaviour must be re-measured against the real corpus before
the §8.4 abstention threshold is calibrated.
**Partial-index asymmetry:** the (grade, subject) filter index is
`WHERE is_active`; the HNSW index is NOT partial. A partial index cannot serve a
query that omits its predicate, and the fallback for the vector index is a scan
of every embedding — which against the `ai` pool's 5s statement timeout reads as
an outage. The filter index can afford that fallback; the vector index cannot.

### D-042 · Indexes follow the queries, which means the requested one was the wrong one
**Status:** Active
The brief asked for an index on `chapter_mastery.student_user_id`.
**Decision:** not created. The composite primary key `(student_user_id,
chapter_id)` is already a btree whose LEADING column is `student_user_id`, so
every progress-screen lookup is index-backed; a second index on the same leading
column costs every write and answers nothing new. A test asserts the query PLAN
uses an index scan, which pins the property that was actually wanted rather than
the mechanism.
**What was created instead** is the mirror image the review found missing:
`chapter_mastery.chapter_id` and `rag_chunks.chapter_id` are foreign keys that
lead nothing, so without an index every `delete from chapters` sequentially
scans them to apply the cascade. A redundant `chapters (grade, subject_code)`
index the generator emitted was also removed — the UNIQUE index covers it.

### D-043 · `question_responses` lands three build steps before its module
**Status:** Active
`practice` is build step 11. Its response log is in migration 0002.
**Decision:** the table is the third one-way door (PROGRESS.md §8) and the only
one whose cost is measured in months. Real question difficulty is computable
only from responses recorded when they happened; there is no reconstruction
later. It lives in `schema/practice.ts` so ownership is honest.
**`authored_difficulty` is DENORMALISED on purpose.** Joining
`questions.difficulty` would look tidier and would destroy the measurement:
correcting a question from 'easy' to 'hard' would retroactively rewrite every
past response to claim the student had faced a hard question.
**The two foreign keys differ deliberately.** Student is CASCADE — a deleted
account takes its answers, and the privacy claim is not negotiable. Question is
RESTRICT — deleting a question destroys the calibration evidence for it, and the
correct way to withdraw one is `is_active = false`; the constraint turns "I'll
tidy up the bank" into an error rather than a loss.
**APPEND-ONLY is a convention, not a trigger.** The only writer is the practice
module's single insert path, and a trigger blocking UPDATE and DELETE would have
to exempt the FK cascade, which is more machinery than the protection is worth
at one writer. Revisit if a second writer appears.

### D-044 · `distractor_misconceptions` is a positional array, and that is a risk worth naming
**Status:** Active — **flagged for review**
The column is a jsonb array of 3 codes aligned to the 3 wrong options, as
specified. Alignment is positional: option index ascending, SKIPPING
`correct_index`.
**The risk:** positional alignment breaks silently if options are ever reordered
or `correct_index` is corrected, and the failure mode is every misconception
being mislabelled with nothing raising an error. A jsonb OBJECT keyed by option
index (`{"0":"...","2":"...","3":"..."}`) would remove the failure mode
entirely at no cost.
**Decision:** the array shape was implemented as specified rather than changed
unilaterally, because it is the contract the authoring and import tooling will
produce against. Three compensating measures: the CHECK enforces exactly 3
elements, the alignment rule is a `COMMENT ON COLUMN` so it survives independent
of the source, and `misconceptionsFor()` in the fixtures is the single
implementation of the rule so no test hand-counts it.
**Open:** if the object shape is preferred, it is a cheap change now and an
expensive one after the bank is authored.

### D-045 · `container.db` is gone; a pool is obtained by naming the module — resolves D-030
**Status:** Active — **resolves D-030**, closes open item 1
D-030 recorded that the `db` → `pools.auth` alias "will become misleading the
moment a second module lands". `learner` and `content` are that moment.
**The failure it was heading for:** a property called `db` reads as "the
database". The second module to be written would have taken it, and every
learner query would then have been competing for the ten connections reserved
for login. The bulkhead would have looked fully wired and been silently gone.
**Decision:** `Container.db` is removed. `Container.poolFor(module)` replaces it,
backed by `MODULE_POOLS` in `platform/db/module-pools.ts` — §3.1's table as
code, typed `Record<ModuleName, PoolName>` so a module added to the union
without a pool is a compile error. There is no general-purpose handle any more:
asking for a pool means naming who is asking.
**The row that is easy to get backwards, and has a test:** `retrieval` and
`content` both read `rag_chunks`, but `retrieval` gets `ai` and `content` gets
`core`. The pool follows the CALLER's cost profile, not the table's owner —
otherwise a slow HNSW scan holds `core` connections and chapter listings queue
behind vector search.

### D-046 · Test harnesses discover migrations; they never list them
**Status:** Active
PROGRESS.md §3 records the defect: the identity harness applied only `0000`, so
every service test ran against a schema with no `link_codes` table, and nothing
went red because the tests that would have noticed had not been written yet.
**Decision:** `applyAllMigrations()` in `tests/helpers/postgres.ts` applies the
whole directory, and `listMigrations()` CROSS-CHECKS the directory against
drizzle's journal, throwing and naming both sides when they disagree. Either
source alone reintroduces the bug from the other direction — the directory alone
would apply a stray `.sql` in the wrong order, and the journal alone would skip
a file whose entry was lost in a merge, which is the original defect in a
different hat. A test run against a half-applied schema is worse than none: it
is green.

### D-047 · Seed and test data are built by the same factories
**Status:** Active
The corpus is blocked on credentials (PROGRESS.md §2) and nine modules sit behind
it. `scripts/seed-dev.ts` builds 6 chapters, 120 questions and 180 chunks
through the `tests/fixtures/` factories rather than its own inserts, so the
CHECK constraints are satisfied in exactly one place and seed data cannot drift
into a shape no test reproduces.
**Embeddings are deterministic synthetic vectors** — FNV-1a → mulberry32 →
Box-Muller → L2-normalised. Normal rather than uniform components matter: uniform
values in [0,1) all point into one orthant and score ~0.75 against each other
regardless of seed, which would make a similarity test unable to fail. Unit
length matches voyage-3, keeping cosine and inner product interchangeable.
**They carry no meaning.** They exercise the plumbing — pgvector column, HNSW
index, distance operator, fusion arithmetic — and say nothing about retrieval
QUALITY. The §8.4 abstention threshold must be measured against the real corpus;
a threshold calibrated against these would be a number with the shape of a
measurement and none of the content. The seed script prints that warning on
every run.
**The held-out reserve is the last slice, not a random one,** so a re-run
reserves the same questions. A shifting reserve would serve a question that was
check-only yesterday, contaminating it — the exact failure the reserve exists to
prevent.

---

## learner + content modules — 9 August 2026

Plan §8.2 and §8.3, plus the misconception shape change and the `ef_search`
setting that were both carried as open items.

### D-048 · `distractor_misconceptions` becomes a jsonb OBJECT keyed by option index — resolves D-044
**Status:** Active — **resolves D-044**, closes open item 1
D-044 implemented the column as a positional array of 3 codes aligned to the 3
wrong options, flagged the shape as a risk in the same entry, and left it open.
Migration `0003_misconception_object` changes it to
`{"0": "confuses_mass_weight", "2": "unit_conversion_step", "3": "sign_error_negative"}`
— keys are option indexes as text, and the key equal to `correct_index` is
absent.
**The failure the array shape allowed, which is the entire argument.** Alignment
was a rule held OUTSIDE the data, in a comment. Reordering the options — a
content edit nobody would think to treat as dangerous — re-points every code at
a different option. Correcting `correct_index` from 1 to 2 shifts all three by
one. In both cases NOTHING ERRORS: there is no constraint to violate, no type to
mismatch, no row count to change. The only visible effect is that the weekly
parent digest starts saying "she is confusing mass with weight" about a child
who is doing nothing of the kind — and that sentence is the whole reason this
product is not a percentage dashboard. It is also untestable under the array
shape, because the data is not wrong; the convention for reading it is.
**Three rules in one CHECK, and the third is what earns the change:** exactly
three entries · every key in "0".."3" · **the key equal to `correct_index` is
ABSENT**. The third converts the silent corruption into a loud rejection —
correcting `correct_index` on a question whose codes were authored for the
previous answer now FAILS, forcing the author to correct the codes with it.
**Operator choice is forced by one restriction:** a CHECK may not contain a
subquery, which rules out `jsonb_object_keys` (set-returning) and every
aggregate. So entry count is `jsonb_array_length(jsonb_path_query_array(x, '$.keyvalue()'))`
(a plain IMMUTABLE scalar function, one array element per entry), legal keys are
`x - array['0','1','2','3'] = '{}'`, and the correct key is `x ? correct_index::text`.
The whole thing is a CASE, not an AND chain, for the D-039 reason — Postgres does
not guarantee `AND` evaluation order, so a non-object value must be refused by a
branch rather than by an operand that happens to run second.
**NOW, because `questions` is empty in every environment.** The migration
rewrites nothing and needs no backfill. Once the bank is authored the same change
costs a data migration that has to infer, per question, which option each
positional code meant — and any question whose options were ever reordered can no
longer be inferred at all. The down migration is deliberately shape-blind and
therefore ABORTS if object-shaped rows exist, which is asserted by a test rather
than discovered.
**Plan patched:** no — §4 does not specify the column's internal shape.

### D-049 · `hnsw.ef_search` is a connection parameter on the `ai` pool, from config
**Status:** Active — closes open item 6, implements D-041's finding
D-041 measured that an HNSW scan returns no more rows than `ef_search`, whose
default is 40, while §8.4 asks for the top 50. The measurement was recorded; the
setting was not applied.
**Decision:** `DATABASE_HNSW_EF_SEARCH` (default 100) is passed to
`createDbPools` and applied as a startup parameter — `-c hnsw.ef_search=100` — on
the **`ai` pool only**.
**A startup parameter rather than a `SET`, for the D-028 reason:** a `SET` can be
missed by a connection created during a reconnect storm or handed out before a
setup query ran, and the connection nobody could account for is exactly the one
that silently under-retrieves. Verified that Postgres accepts a namespaced
setting it does not yet recognise as a PLACEHOLDER and reconciles it when
pgvector loads — so this works on a connection made before `create extension
vector` has run, which a migration harness does.
**On the `ai` pool only, and not in the retrieval module,** because the setting
has to be present on every connection a vector query could run on: a module-level
`SET` is one that some future second query path forgets. The other three pools
never touch the HNSW index.
**The test has a CONTROL, and that is the load-bearing half.** One test asserts
the top-50 query returns 50 on the `ai` pool; a second drives the same query at
`ef_search = 40` and asserts it returns 40. Without the second, the first would
keep passing if pgvector ever stopped capping — and would have silently stopped
measuring anything.
**Two things the tests found rather than reasoned out:** `SET LOCAL` outside an
explicit transaction is a no-op that only warns, so the first draft's override
did nothing and the control returned 50, looking exactly like "the cap is gone";
and `enable_seqscan = off` is required, because at seed scale the planner
prefers an exact sort — which is both faster and perfectly accurate, and would
have turned both tests into tests of nothing.

### D-050 · `parseInput` moves to `platform/validation`
**Status:** Active
It was a private function in `identity.schema.ts`, correct while identity was the
only module with routes. `learner` and `content` are the second and third.
**Decision:** it lives in `platform/validation` and is re-exported from each
module's `*.schema.ts`, so route files still reach it through one import.
**Not a tidiness change.** This function decides what a client is told when its
request is malformed, which is a DISCLOSURE decision: a third copy that drifts
into including the received VALUE in the message is a copy that echoes a password
back in a 400. It contains no business rule — it turns a `ZodError` into an
`AppError` — so it belongs in platform under the §2 layer table.

### D-051 · The cross-module edges are INJECTED, not imported
**Status:** Active
`learner` needs two things from `identity`: the session-validation preHandler,
and the current parent-child link status. Neither is imported.
**Decision:** both arrive as constructor dependencies, wired in `app/routes.ts`.
That file is therefore the complete, greppable cross-module dependency graph —
searching it gives you every edge in the system, and a module cannot acquire a
dependency without the composition root gaining a line.
**The link reader collapses to `'approved' | null`** rather than exposing the
real three-valued status, because that is the only distinction the authz boundary
is ALLOWED to make: telling `pending` from `revoked` from "no link at all" in a
403 would reveal whether a given student account exists (§7 rule 2). Returning
the full status would hand every future call site the ability to leak that, for
no behaviour any of them needs.
**Consequence:** `registerRoutes` takes `Partial<Modules>` while `buildModules`
returns the total `Modules`. A test harness legitimately wants one module and no
others; production goes through `buildModules`, so a real deployment still cannot
drop one by omission. `src/app/__tests__/routes.test.ts` pins the pool each
module receives, which is the assertion D-045 left with no test behind it.

### D-052 · The held-out reserve is protected by a FUNCTION NAME, not a flag
**Status:** Active
§8.3 requires that practice never serves a held-out question. PROGRESS.md §8
records why: a question that has been practised may have been memorised and can
never measure anything again, for that student, permanently. There is no cleanup
and no recovery — you cannot un-serve a question.
**Decision:** `getQuestionsForChapter` has NO PARAMETER that could include the
reserve. The reserve is reached only through the separately named
`getHeldOutQuestionsForChapter`. At the repository, the pool is a required
`'practice' | 'held-out'` discriminator with no default.
**Why not `{ includeHeldOut = false }`:** a default is a value a caller never has
to think about, so the caller who thinks about it wrongly — or copies a call
site — reaches the reserve by omission, and forgetting an argument is not a rare
event. The protection has to be the SHAPE of the interface rather than the
discipline of the caller, because the discipline is what fails.
**Enforced by the access path too:** the three predicates (chapter, active,
held-out) are the exact leading columns of
`questions_chapter_active_held_out_idx`, so the reserve is separated by the index
rather than by a filter applied after rows are read. A test asserts that a
payload carrying `includeHeldOut: true`, `heldOut: true` and `pool: 'held-out'`
still returns nothing.

### D-053 · Onboarding is `ON CONFLICT DO NOTHING`, never `DO UPDATE`
**Status:** Active
§8.2 requires onboarding to be idempotent. It is the screen straight after email
verification, on Indian mobile networks, and a retried POST is the normal case:
the user taps twice, the connection drops after the write but before the
response, the app resumes from a cold start.
**Decision:** the profile insert and the subject inserts are ONE transaction,
both `DO NOTHING`, and the result carries `created: false` when the profile
already existed.
**`DO UPDATE` would satisfy "no duplicate rows" and violate the actual
requirement.** An upsert re-writes `display_name`, `grade` and `board` from
whatever the retry happened to carry — so a student who moved to grade 9 and
whose app replays a stale cached request is silently moved back to grade 8, and
every chapter they see changes. "This profile already exists" means leave it
alone and say so. Deliberately changing a grade is `updateProfile`, an explicit
PATCH.
**One transaction because the profile and its subjects are one fact.** A crash
between them leaves a student with a profile and no subjects, which every
downstream screen reads as "this student studies nothing" — and which no retry
fixes, because the retry sees the profile already exists and does nothing.
**The status code does not vary** between the first call and a repeat. A client
retrying after a dropped connection cannot tell which of its two attempts
arrived, so a status that differs between them is a difference it can only
misread.

### D-054 · Three defences for mastery bounds, deliberately different at each layer
**Status:** Active
`masteryScoreSchema` REFUSES an out-of-range value; `clampMastery` CLAMPS one;
the CHECK constraint is the backstop.
**Decision, and why this is not redundancy:** they cover three different callers.
A value arriving over HTTP at 1.4 means the CALLER has a bug, and clamping it
would hide that bug behind a plausible 1.0. A value the system COMPUTED at
1.0000001 is floating-point arithmetic, not a bug, and refusing it would fail a
student's submission over a rounding artefact. The CHECK turns a clamping bug
into a loud failure rather than a mastery of 1.4 sitting in a parent report.
**A non-finite input THROWS rather than clamping.** `NaN` is not a value at one
end of the range — it is the residue of a division by zero upstream, most
plausibly `correct / total` on a session with no questions. Clamping it to 0
records "this student knows nothing about this chapter", which is a specific and
wrong claim, and erases the evidence of the bug that produced it.
**`updateMastery` has no endpoint,** and §8.2 lists none. Mastery is derived from
practice; a route that let a client post its own would let a student declare
themselves expert and make every parent report meaningless.

### D-055 · The password-corpus timing assertion is RELATIVE, not a millisecond budget
**Status:** Active — a flaky test fixed rather than re-tuned
`password.test.ts` asserted that 20,000 deny-list lookups complete in under
500 ms. It failed at 558 ms under `--coverage` with four database-backed suites
running in parallel — nothing was slow, the machine was busy and every line was
instrumented. The new suites in this pass are what tipped it over.
**Decision:** the bound is derived from a linear scan timed in the SAME LOOP
SHAPE at the same moment, then projected: `elapsedMs < projectedScanMs / 2`.
**Why not simply raise the number.** The measured cost of a real linear-scan
implementation is ~1.1 s, so any budget loose enough to survive a busy CI box is
also loose enough to accept the very implementation the test exists to reject.
The absolute form could not express the property at all.
**Measured ratios, both worth recording:** ~16x on a plain run, ~3.8x under
coverage. Instrumentation is not symmetric — the 20,000-iteration loop is fully
instrumented while `Array.prototype.includes` is native and untouched — so
coverage compresses the ratio being measured. That gap is exactly what an
absolute budget has to straddle, and why it kept being wrong.

---

## Open items — agreed, not yet implemented

| # | Item | Source | Effort |
|---|---|---|---|
| 1 | Remove the `/health` alias once deployment manifests point at `/health/live` | D-024 | ~15 min |
| 2 | A real metrics port, so `MetricsSink` stops being a module-local interface | D-034 | ~2 h |
| 3 | Re-check the origin allow-list when the Flutter or any non-browser client lands — it sends no `Origin`, and the answer is a signed client credential, never a loosened check | D-035 | — |
| 4 | "All four options are DISTINCT" is a content-module rule with no owner. A CHECK cannot express it (no subquery, needs aggregation). Now that `content` exists it has somewhere to live — apply it in the repository's write path when one is built, or as a validation on import | D-039 | ~30 min |
| 5 | The global 100-per-minute authenticated rate limit is now UNBLOCKED — it was waiting on a second module having routes, and there are now three | plan §6.9 | ~2 h |

**Done in the 8 August platform hardening pass:** `link_codes` table (D-021) and explicit `APP_URL` / `API_URL` (D-022).
**Done in the 8 August identity hardening pass:** full common-password corpus (was item 1, D-036), rate-limit in-process fallback (was item 2, D-034), `Origin` check (was item 3, D-035), identity repointed off the cache and `codeExpiresAt` removed (was item 4, D-033).
**Done in the 9 August schema pass:** explicit per-module pools and the removal of the `container.db` alias (was item 1, D-045, resolving D-030).
**Done in the 9 August learner + content pass:** the misconception object shape (was item 1, D-048, resolving D-044) and `hnsw.ef_search` on the `ai` pool (was item 6 in PROGRESS.md §7, D-049, implementing D-041).

## Deferred deliberately

| Item | Waiting on |
|---|---|
| ~~Global 100-per-minute authenticated rate limit~~ | ~~a second module having routes~~ — **UNBLOCKED 9 August**, three modules now have routes. Moved to open items |
| Expired-session sweeper | the job worker process |
| Reset-token invalidation when a password changes by another route | not in the plan; normal follow-up |
| Repeated-failed-login lockout and notification | not in the plan; normal follow-up |

---

## Design decisions taken by the orchestrator — 9 August 2026

These resolve four problems surfaced while building `learner` and `content`. All four must be settled before `practice` starts.

### D-056 · Transactions are owned by the service layer; repositories accept an executor
**Status:** Active — **supersedes the plan's "repositories own their transaction boundaries"**
Plan section 8.6 requires quiz submission to write responses, session, XP ledger and mastery in **one transaction**. But `chapter_mastery` belongs to `learner`, and `learner.updateMastery` opened its own transaction, so `practice` could not enlist it.

The rejected framing was that passing a transaction handle across a module boundary leaks `platform/db` types. It does not: **`modules → platform` is an explicitly allowed dependency edge.** Every module already imports `platform/errors` and `platform/clock`. An executor type is exactly the same kind of shared infrastructure type.

**Decision:**
- `platform/db` exports an opaque `Executor` type.
- Repository functions take an optional executor and default to their module's pool.
- Public module functions that mutate data accept an optional executor in their input.
- **The service layer opens the transaction; repositories never do.**

**Consequence:** `practice.submitSession` opens one transaction and passes the executor to `learner.updateMastery`. Atomicity is preserved and no ownership is violated. The alternatives — practice writing another module's table, or mastery becoming eventually consistent — both break something the plan calls non-negotiable.

### D-057 · `question_responses` and `practice_responses` merge into one table
**Status:** Active — supersedes part of plan section 4 and D-043
The two tables carried nearly identical fields. `practice_responses` has the `session_id` that submission idempotency needs; `question_responses` has the `authored_difficulty` that future difficulty calibration needs. Keeping both means `practice` writes each row twice and the two can disagree.

**Decision:** one table, `practice_responses`, carrying `session_id`, `question_id`, `selected_index`, `is_correct`, `time_spent_ms`, `authored_difficulty`. `question_responses` is dropped.
The one-way door in PROGRESS.md section 8 is satisfied by the **columns**, not by a separate table. `authored_difficulty` is still captured on every response, which is the part that is unrecoverable if skipped.

### D-058 · `selected_index` always stores the ORIGINAL option index
**Status:** Active
Practice shuffles options per session. Misconceptions are keyed by original option index (D-048). If the stored index were the shuffled one, every misconception lookup would be wrong.

**Decision:** the shuffle is a **presentation concern only**. Practice retains the shuffle map for the session and translates the student's selection back to the original index before storing anything. **Every persisted index is canonical.**
Recorded in a `COMMENT ON COLUMN`, because this is invisible in the type and impossible to infer from the data.

### D-059 · Chunk-to-chapter linkage is measured at import, not assumed
**Status:** **Needs review at import time**
`rag_chunks.chapter_id` is nullable and unbackfilled. The intended backfill joins `(grade, subject, chapter_number)` to `chapters`, but `chapter_number` is **also** nullable in the source. Chunks lacking it can never be linked, so chapter-scoped retrieval silently under-covers.

**Decision:** before the import completes, run
```sql
SELECT count(*) FILTER (WHERE chapter_number IS NULL) AS unlinkable, count(*) AS total
FROM rag_content_chunks;
```
If the unlinkable share is material, chapter-scoped retrieval degrades and either the chunks need enrichment or the feature needs re-scoping. **Do not calibrate the retrieval threshold before this number is known.**

### D-060 · `getChunksByIds` returns rows in arbitrary order
**Status:** Active — a note for whoever builds `retrieval`
The query uses `IN (...)`, so row order is not the order of the array passed in. **Retrieval must re-apply its own ranking after hydration.** Relying on the returned order would silently scramble ranking — the answer would still look plausible, which is the worst kind of failure.

---

## Foundation hooks — 9 August 2026

The six items in `05-ROADMAP.md` section 8, built in one pass. Each is cheap now and expensive or impossible later; **none of the features they support is being built.** Migrations `0004`-`0007`.

### D-061 · `tenant_id` is nullable with a default, and the enforcement lives in `platform/authz`
**Status:** Active — **the strictness is deliberately provisional; see the exit condition**
05-ROADMAP.md section 7 calls `tenant_id` "the one item on this roadmap that is genuinely expensive to retrofit… with no safe intermediate state." The expensive half is the "no safe intermediate state": a retrofit adds the column, backfills, tightens, then repoints every query and every authorisation check — and between the first and last steps the system runs with some reads tenant-scoped and some not. That window is where one school sees another's children, and it cannot be closed with a flag because it spans a schema change.

**Decision:** `tenant_id` lands on the six tables carrying student data (`users`, `parent_child_links`, `students`, `student_subjects`, `chapter_mastery`, `question_responses`), NULLABLE with a DEFAULT of the single seeded tenant, indexed everywhere it will be filtered, `ON DELETE RESTRICT` everywhere.

**The enforcement is NOT the column.** It is `assertCanAccess`, which denies a tenant mismatch **before any allow rule is considered** — so a parent reading a child they hold an approved, student-consented link to, in another tenant, is refused. The alternative (a `where tenant_id = $1` in every query) is enforced by remembering, and fails the first time somebody forgets.

**The compromise, stated plainly:** both sides are optional and the rule is "deny when BOTH are present and they differ". A caller that forgets to populate `resource.tenantId` gets no enforcement on that call. This is right today — there is one tenant, and requiring both would force every insert path in three modules to change on the same day, which is the very cost the hook exists to avoid — and it will be wrong later.

**EXIT CONDITION, and it is a hard one:** *before a second tenant row is ever created*, `tenantId` becomes REQUIRED on `Actor` and on every tenant-scoped `Resource`, the columns become NOT NULL, and the guard denies when either side is missing. That change is mechanical (the compiler lists every call site) and it is only mechanical because the column, the type and the branch already exist.

### D-062 · `ActorRole` widens with the column, and the rules stay narrow
**Status:** Active
Migration `0005` widens the `users.role` CHECK from two values to ten so Phase 1 does not need a locking DDL change on a live table.

**Decision:** `ActorRole` widens to match. It HAD to: while the type said `'student' | 'parent'`, the `student-data` branch read as "if student … otherwise parent", so the first `teacher` row to reach the guard would have been judged by the PARENT rules — a privilege escalation delivered by a type that was merely out of date. The branch now names `student` and `parent` explicitly and every other role falls to the default deny, `super_admin` included.

**Signup is unchanged.** `PLATFORM_ROLES` (what the column accepts) and `SIGNUP_ROLES` (what a person may claim) are separate constants in `shared/constants/roles.ts`, and `roleSchema` is built from the second. A test drives all eight widened roles at `POST /auth/signup` and asserts a 400 for each — **that test is the whole defence**, because pointing `roleSchema` at `PLATFORM_ROLES` would compile, insert, and hand the internet a `super_admin` dropdown.

### D-063 · `audit_log` is append-only by TRIGGER, not by convention
**Status:** Active — **departs from the `question_responses` precedent, on purpose**
`question_responses` is append-only by convention, and its header justifies that: one writer, and a trigger would have had to exempt an FK cascade. Neither holds here. Every module will eventually write to `audit_log`, and an audit log the application can UPDATE is one a bug — or a person with a database connection — can quietly correct.

**Decision:** `BEFORE UPDATE` and `BEFORE DELETE` triggers that raise unconditionally, with SQLSTATE `2F004` so a caller can tell the refusal from a constraint violation.

**TRUNCATE is deliberately NOT blocked.** Row triggers do not fire on it, it requires table ownership (which the application role does not hold in a real deployment), and it is the only mechanism left for retention and for resetting a test database now that DELETE is refused. Blocking it would leave the table with no legal way to ever shrink.

**`actor_user_id` has NO foreign key**, and this is load-bearing rather than an omission: `ON DELETE CASCADE` would delete a user's audit trail on account deletion — the one thing an audit log must not do — and it would do it with a DELETE, which the trigger refuses, so account deletion would FAIL. `SET NULL` fails identically, being an UPDATE. Any referential action turns "delete my account" into "the audit trigger raised".

### D-064 · PII is REDACTED on the way into permanent records, never rejected
**Status:** Active
`audit_log.metadata` and `metrics_events.tags` are arbitrary jsonb, written by any module, kept forever. Pino's path-based redaction cannot help: nobody knows the paths in advance.

**Decision:** `platform/pii` scrubs both, by two mechanisms — PII-shaped KEYS are dropped whole (by name, whatever they contain), PII-shaped VALUES are redacted wherever they appear (which is what catches an address buried in a `note`).

**Redact, do not reject.** Rejecting would mean a defect in the RECORD of a security operation fails the SECURITY OPERATION — a password reset blocked because its receipt could not be filed. Every scrub is logged at `warn` with the KEYS (never the values) and counted, because a module putting personal data in an audit payload is a defect to fix at the source.

**What it does not claim:** it catches the accident, not the intent. `a (at) b (dot) com` passes straight through, and there is a test asserting exactly that. The rule that protects the data is "metadata is identifiers and counts", stated on the column comments and enforced in review.

### D-065 · Evidence capture lands on `question_responses`, ahead of D-057's rename
**Status:** Active — **note for whoever implements D-057**
05-ROADMAP.md section 8 rates the five evidence columns "Unrecoverable" if skipped: the Phase 1 teacher screen and the Phase 4 principal dashboard run on them, and a student who practised in September leaves no trace of a changed answer unless the column existed in September.

D-057 decides that `question_responses` and a future `practice_responses` merge into one table, when `practice` is built (step 11). **It has not happened.**

**Decision:** the five columns — `first_selected_index`, `answer_changed`, `hint_level_used`, `confidence`, `explanation_format_used` — go on `question_responses` now. The D-057 rename carries them for free. Waiting for it would mean waiting eight build steps, which is the delay this hook exists to prevent.

**`hint_level_used` is the only NOT NULL one**, defaulting to 0, because "no hints" is a real observation rather than an absent one. **`confidence` is CHECKed and `explanation_format_used` is not**, and the contrast is the rule: `confidence` is a DECISION column (remediation branches on it), `explanation_format_used` is an ANALYTICS column, so an unexpected value costs a report line rather than a wrong answer. Every column carries a `COMMENT ON COLUMN`, because none of this is inferable from a column name six months from now.

### D-066 · The notification dispatcher holds the mechanism; the policy is injected
**Status:** Active
`platform/` holds no business logic, and "a parent's weekly digest goes over WhatsApp and email, but a mission nudge is in-app only and respects quiet hours" is product policy belonging to `notify` (build step 14).

**Decision:** the dispatcher owns fan-out, preference filtering and outcome recording, and takes routing as DATA — `ChannelPolicy`, a map from message kind to an ordered channel list. The container passes an empty policy, so every kind falls through to in-app only. A `switch (message.kind)` in `platform/` would have had quiet hours living there within two sprints.

**Two sub-decisions worth recording.** `in-app` cannot be opted out of: opting out of an in-app notification is opting out of a page, and allowing it creates the state "the system needed to tell you something and had nowhere to put it". And preference FILTERS the policy but can never extend it — opting in to a channel the product does not use for that kind asks for a message with no template.

### D-067 · Unimplemented channels THROW; they do not report a failed delivery
**Status:** Active
`whatsapp` and `push` are declared in `ChannelName` but cannot be built (Meta template approval; a mobile app to hold the token).

**Decision:** both exist as adapters that reject with `DependencyError`. Two reasons. The channel map stays TOTAL over `ChannelName`, so the dispatcher has one failure path instead of two ("this channel failed" and "this channel does not exist" are indistinguishable to a caller). And a throw is LOUD: returning `{ delivered: false, reason: 'not implemented' }` is a silent failure wearing the costume of a handled one — identical in shape to "this parent has no phone number" — so somebody enables WhatsApp in a policy six months later, nothing errors, and every digest is quietly not sent.

### D-068 · Metrics are fire-and-forget, tee'd to memory and Postgres
**Status:** Active — **closes the gap 04-RESILIENCE-PLAN.md section 5 left open**
Section 5 requires every breaker transition to be "logged at `warn` and emitted as a metric". Only the first half was true: the sole implementation was `createNoopBreakerMetrics()`, whose own comment said the sink "lands with the metrics port". The same was true of D-034's rate-limit fallback metric — the signal that **authentication has silently degraded** — whose only implementation was `NO_METRICS`.

**Decision:** `platform/metrics` with `counter`/`gauge`/`histogram` returning `void`. Not `Promise<void>`: an awaitable metric puts the metrics backend on the critical path of the request it measures, so an outage in the thing that tells you about outages becomes an outage.

**Two sinks.** In-memory answers "what is happening in this process right now" and is what `/health/deps` reports — querying a table to report that the database is unreachable would fail exactly when it is needed. A buffered Postgres writer answers "what happened last Tuesday", writes on the `worker` pool, and drops with a `warn` on failure.

**Wired into four things at the registry rather than at six call sites:** breaker transitions, breaker rejections, concurrency-limit rejections and port timeouts. Six ports each remembering to emit is five chances to forget, and the one that forgets is discovered during an incident.

**Deliberately a plain table, not a time-series store.** The events are exceptional, not per-request. If a metric ever needs per-request granularity that is the trigger to write a second adapter — not to start writing a row per request here.

### D-069 · The job queue is Postgres with `FOR UPDATE SKIP LOCKED`, and at-least-once is assumed
**Status:** Active
00-ARCHITECTURE.md section 0 approves three external services; a broker is not among them, and adding one to deliver a weekly digest would be the most expensive line in the deployment.

**Decision:** a `jobs` table, claimed with `FOR UPDATE SKIP LOCKED` inside the UPDATE's subquery — the one construct Drizzle cannot express, so it is raw (parameterised) SQL. Without `SKIP LOCKED` every worker serialises behind the first; without `FOR UPDATE` two workers claim the same row.

**At-least-once is assumed, not avoided.** A worker can complete the work and die before recording it. No queue prevents that; the honest response is to require handlers to be idempotent and to make deduplication explicit: `(kind, idempotency_key)` is UNIQUE, and **the key MUST be derived from what makes the work unique — never a timestamp, never random.**

**`attempts` increments on CLAIM, not on failure.** A worker killed mid-job never calls `fail()`; if the counter only advanced there, a poison job would be reclaimed forever with `attempts` at zero and never reach `dead`.

**Recurring work has no scheduler and no timer.** Every tick asserts that today's job exists, keyed `<kind>:<UTC date>`. Ten replicas produce one row a day; a worker restarted at 23:58 does the right thing; a worker down for a day catches up. The UNIQUE index does what scheduler state would otherwise do. **The limit: this expresses daily-or-coarser only** — "09:00 Asia/Kolkata", which the parent digest will want, needs a `run_at` computed in the target timezone.

### D-070 · The worker's shutdown must NOT await its own loop after the drain deadline
**Status:** Active — **found by a test, and it is a trap worth naming**
Section 12 step 3: finish the current job, up to 30 s, claim no new ones.

The obvious implementation — set the flag, await the job with a deadline, then await the loop so you know it has ended — **defeats the deadline.** The loop is itself sitting on `await current`, so awaiting it waits for exactly the job that was just given up on. The timeout logs and then blocks forever anyway: a shutdown window that reports being exceeded and honours it regardless.

**Decision:** the loop is awaited only when the drain actually finished. When it did not, `stop()` returns immediately and the abandoned job dies with the process. That is not a leak — the stuck-job reaper returns the row to the queue and the handler runs again, which is safe precisely because handlers must be idempotent.

**The other half:** `stopping` is checked immediately before the CLAIM, not once per loop iteration. A job claimed one millisecond into a shutdown is killed thirty seconds later and reclaimed, so it runs twice for no reason at all.

### D-071 · The worker gets a heartbeat ROW, not a health endpoint
**Status:** Active
Section 8's three endpoints work because something calls them. The worker has no listener.

**Decision:** `worker_heartbeats`, stamped on every loop. Giving the worker an HTTP server purely to be probed would mean a port, a second shutdown path, and a liveness answer that is true whenever the HTTP server is alive — which says nothing about whether the job loop is turning. A worker whose loop had deadlocked would answer 200 all day. A heartbeat row is only fresh if the LOOP ran.

One row per PROCESS, keyed by hostname, pid and start time: a single shared row would make two healthy workers indistinguishable from one healthy worker and one that died an hour ago.

### D-072 · Defects found by tests during this pass
**Status:** Recorded

| Defect | Would have caused |
|---|---|
| `tests/integration/pool-bulkhead.test.ts` hardcoded its migration list (`0000`, `0001`) | The exact D-046 defect again. It surfaced only when `0004` added `users.tenant_id`, because Drizzle's `.returning()` projects every column the SCHEMA declares — so signup asked for a column that database had never been given, and the failure landed in `createUser`, several layers from the hardcoded list that caused it |
| `createBreakerMetricsBridge` implemented `onTransition` but not `onRejected` | The transition count would have shipped without the COST count. A breaker open for four minutes rejecting three thousand calls would have looked identical to one that flapped twice with no traffic |
| `JobRunner.stop()` awaited the loop after the drain deadline expired | The 30-second shutdown window would have logged "exceeded" and then blocked indefinitely. See D-070 |
| `RecordingSleeper` resolves as a MICROtask, so a poll loop built on it starves the macrotask queue | The runner tests hung with one CPU pegged and no failing assertion — vitest simply timed out. Production is unaffected (`createRealSleeper` uses `setTimeout`); the fix belongs to the fake |
| The test container's `max_connections` default of 100 was exceeded by the five new database-backed suites | Intermittent `Connection terminated unexpectedly` inside a `beforeAll`, landing on a different file each run. One run red, the next green, nothing wrong with the code |
| A missing `-c` before `max_connections=200` in the container command | `postgres` refuses to start, and the ONLY symptom is testcontainers reporting "Log stream ended and message … was not received" with `Test Files: no tests`. Nothing mentions the argument and no container survives to inspect |

---

## Orchestrator decisions — 9 August 2026 (after the foundation-hooks wave)

### D-073 · `tenant_id` enforcement is tightened to NOT NULL with a strict guard
**Status:** **RESOLVED, 10 August 2026** — migration `0008_tenant_not_null`. See the D-073 entry under "Wave 1" at the end of this file for what was built.
The implementing agent flagged, correctly, that enforcement is weaker than the brief implied: both sides of the comparison are optional, so the guard denies only when a tenant is present on both and they differ. Requiring both would have meant changing every insert path across three modules.

**Why that is not acceptable as a resting state.** `tenant_id` was added now, ahead of need, for exactly one reason: to avoid a migration across every table, query and authorisation check once real student data exists. A nullable column with a lenient guard **does not avoid that migration — it defers it**, and it does so while reading as complete. That is the worst of both: the cost is still owed, and the tracker says it is paid.

**Decision:** make `tenant_id` NOT NULL, defaulted to the seeded tenant, and require both sides present in `assertCanAccess`. Update the insert paths in `identity`, `learner` and `content`.
**Cost now:** about 1 day, on empty tables. **Cost later:** the migration we are trying to avoid, on live student rows.
**Do this before any further module is built**, because every new module adds insert paths to the same change.

### D-074 · The `schools` / `classes` / `class_enrolments` stub was low value — acknowledged
**Status:** Active — kept, not defended
The agent's objection is correct and is recorded rather than argued away. Unlike `tenant_id`, these tables are trivially addable later: three `CREATE TABLE`s against tables nothing yet references. The roadmap's 8-day figure was the cost of **repointing students and queries**, which a stub nothing points at does not avoid.

Kept because it is built and harmless. **The lesson generalises:** a hook is only worth building early when the expensive part is the *retrofit*, not the *creation*. `tenant_id` passes that test. An unreferenced table does not. Apply this test to future roadmap section 8 items.

### D-075 · The migration-list defect recurred; the pattern must be made impossible
**Status:** **RESOLVED, 10 August 2026** — an ESLint `no-restricted-syntax` rule now rejects the array form. A THIRD instance was found and fixed in the same pass. See the D-075 entry under "Wave 1" at the end of this file.
`pool-bulkhead.test.ts` hardcoded its migration list — **the same defect as D-046, appearing a second time**, three layers from its cause. It was fixed twice; that is the signal.

**Decision:** no test harness may name migrations. Discovery from the migration directory is the only permitted mechanism, and a lint rule or a shared helper should make the hardcoded form unavailable rather than merely discouraged. A defect that recurs after being fixed is a design problem, not a coding mistake.

---

## Corpus reconnaissance — 9 August 2026

The Supabase MCP connection reaches the source project with read access and SQL execution. **No credentials exchange is required.** The content-count question, open for four sessions, is answered.

Source project: *Alfanumrik Adaptive Learning OS*, ref `shktyoxqhundlvkiwguu`, ap-south-1, ACTIVE, Postgres 17.

### D-076 · Grade and subject formats must be normalised during import
**Status:** Active — a hard requirement on the import script
The source tables disagree with each other:

| Table | `grade` | `subject` |
|---|---|---|
| `rag_content_chunks` | **`'Grade 6'`..`'Grade 12'`** | Title Case with spaces — `Social Studies` |
| `question_bank` | `'6'`..`'12'` | snake_case — `social_studies`, `history_sr` |
| `chapter_concepts`, `cbse_syllabus` | `'6'`..`'12'` | mixed |

Our `rag_chunks.grade` carries a CHECK restricting it to `'6'`..`'12'`, so an unnormalised import **fails loudly** — which is the correct behaviour and the reason the constraint exists.
**Decision:** the import script normalises both fields on the way in. Grade strips any `Grade ` prefix; subject maps to a single canonical vocabulary declared in `shared/constants/curriculum.ts`. `history_sr` needs an explicit mapping decision, not a guess.
**Also:** `embedding_model` carries two labels for the same model — `voyage/voyage-3` and `voyage-3`. Harmless for retrieval, but it breaks any exact-match filter. Normalise it too.

### D-077 · The question-level pedagogy layer does not exist and must be generated
**Status:** **Needs review — this is the significant finding**
The content pipeline produced **concepts** but never produced **question-level pedagogy**. Measured:

| Asset | Count |
|---|---|
| `chapter_concepts` | 3,330 — 96% with Hindi, 62% with worked examples |
| `concept_graph` edges | 572 |
| `misconception_patterns` | 72, **orphaned — nothing links them to questions** |
| `question_misconceptions` | **0** |
| `wrong_answer_remediations` | **0** |
| `question_bank.hint_level_1` populated | **0** |
| `question_bank.solution_steps` populated | **0** |

**Consequence:** the client's Screen 6 hint ladder, Screen 7 misconception-driven branching, and the parent digest's named misconception all have **no data behind them today**. This was the largest unpriced risk in the plan; it is now a measured gap.

**Decision:** generate it, scoped to the pilot — not across all 18,765 questions.
- One subject and one grade is roughly 300-600 questions
- Per question: 3 hint levels, solution steps, and a misconception code per distractor with its remediation
- Cost is a few days of generation plus a human verification pass, not months
- **Generating across the full bank is explicitly out of scope** until the pilot proves the format

### D-078 · ~~2,564 chunks carry no embedding and must be re-embedded~~ → **20 chunks, measured**
**Status:** **Superseded in its numbers, 10 August 2026.** The concern was real; the figures were not. Both are stated below so the correction is legible rather than a silent overwrite.

**What this entry said:** 9.2% of chunks — 2,564 — are stamped `mistral-embed` with a **NULL vector**, invisible to vector retrieval, and must be re-embedded with `voyage-3` at 1024 dimensions **before threshold calibration**, or the calibration is measured against a corpus with a 9% hole in it.

**What the imported database actually holds** (`select count(*) … from rag_chunks`, dev, 10 August 2026):

| | rows |
|---|---|
| imported | **4,686** |
| active (`is_active`) | **4,403** |
| active with a NULL embedding | **20** |
| active with an embedding | **4,383** |

**So: 20, not 2,564 — 0.45% of the active corpus, not 9.2%.** The original count described the SOURCE export; the importer is what decided which rows landed and which were skipped, and the two were never reconciled.

**Consequences of the correction:**
- **The blocker is void.** Threshold calibration did not need to wait for a re-embed, and it ran on this corpus on 10 August 2026 (see D-179). A 0.45% hole does not move a percentile.
- **Re-embedding 20 chunks is a chore, not a project.** Still worth doing — they are invisible to the dense half — but it does not gate anything.
- **`4,403` is the number to quote for "the corpus", not `4,686`.** They differ by 283 inactive rows, and the active count is the population a query can return. Anywhere a comment or a threshold's provenance says how large the corpus is, it means the active count.
- The unchanged half of the entry: those 20 rows are **real content, reachable by full-text search**, which is why they were imported rather than skipped. `retrieval.repository.ts`'s dense query excludes them explicitly (`embedding is not null`) so pgvector cannot sort NULL distances into the top 50.

**The lesson, which is the reusable part:** this figure sat in the log for months, was quoted in five source comments, and gated a piece of work — and nobody had run the count against the database it described. A number in this log that has never been re-measured against the system it claims to describe is a hypothesis with a table around it.

### D-059 · RESOLVED — chunk-to-chapter linkage is sound
`chapter_number IS NULL` returns **0 rows** across all 27,778 chunks. Chapter-scoped retrieval will not under-cover. The concern is closed.

### D-079 · Question density is thin for a 30% held-out reserve
**Status:** Needs review
Median questions per chapter is **15** (mean 20.5, min 1, max 75) across 914 chapter groups. Reserving 30% for independent mastery checks leaves roughly 10 for practice — workable but thin, and the minimum of 1 means some chapters cannot support a reserve at all.
**Decision:** for pilot chapters, **generate additional questions rather than shrink the reserve.** The reserve is a one-way door (a served question is contaminated permanently); question count is not.

### Verification status — context for content readiness
15.3% of questions are verified (2,871 of 18,765), and the verified set contains **zero** Grade 11-12 humanities or commerce. `cbse_syllabus` has **no** rows at `rag_status = 'ready'` — 889 partial, 259 missing. Per the source system's own rule, `'ready'` requires both a chunk count and a verified-question count, so this reflects **thin verification, not missing content**. Choose the pilot subject from the verified STEM set.

---

## Frontend delivery boundary — 10 August 2026

### D-080 · Marketing and product are separate deployables; published marketing is static
**Status:** Active — supersedes any reading of the earlier frontend plan as one combined website

**Brand:** Alfanumrik is the customer-facing platform, Foxy is its AI tutor feature, and Foxxy remains the repository name.

**Surfaces:** the main domain serves the statically generated marketing site, `app.<domain>` serves the authenticated product, and `api.<domain>` serves Fastify. `example.com` in planning documents is a placeholder; the real origins must be written into required `APP_URL`, `API_URL`, and exact `CORS_READ_ORIGINS` / `CORS_WRITE_ORIGINS` deployment values before launch (the single `CORS_ORIGINS` was split by D-082).

**Isolation decision:** `website/`, `frontend/`, and `backend/` have independent dependencies, images, Compose project names, credentials and path-scoped pipelines. Proxy configuration belongs to a fourth, infrastructure-owned deployment that application pipelines cannot modify. The marketing CMS/database and media are isolated from product storage and included in the same WAL, offsite-backup and monthly restore-drill discipline as product data.

**Availability decision:** Payload owns editing, drafts, preview and versions, but public marketing pages are built from a published snapshot into an atomically deployed static artifact. Public requests never query the CMS database, so CMS down does not mean marketing down and a failed publish leaves the previous artifact live.

**Transport decision:** product fetches always use `credentials: 'include'`; Fastify CORS returns the exact app origin with credentials enabled and never `*`; the session cookie remains host-bound and `SameSite=Lax`. Verification stays a top-level API GET followed by a 302 to the app onboarding route. Foxy SSE receives an API-route-specific no-buffer/long-timeout proxy policy.

**Data and discovery decision:** marketing analytics use self-hosted GoatCounter in aggregate, cookieless mode; the product remains `noindex` and outside the marketing sitemap. Lead forms collect adult contact data and consent only, retain unconverted leads for 90 days, and never collect child data. CMS administrative mail uses workspace identities and a CMS-local Resend adapter, never the product mail port.

---

## Wave 1 — closing the half-done foundations, 10 August 2026

### D-073 · RESOLVED — `tenant_id` is NOT NULL and the guard is strict
**Status:** **Resolved.** Migration `0008_tenant_not_null`, plus changes in `platform/authz`, `identity`, `learner`.

What D-073 agreed is now built:

- **The column.** `0008` backfills and sets `NOT NULL` on the six student-owned tables — `users`, `parent_child_links`, `students`, `student_subjects`, `chapter_mastery`, `question_responses`. The `DEFAULT` from 0004 stays; it is what makes `SET NOT NULL` metadata-only and what keeps a psql repair working. **It is explicitly not the enforcement** — a default cannot tell "not supplied" from "supplied and equal to the default", so if it ever became the only mechanism, every row would silently land in the first tenant the day a second one exists.
- **The guard.** `Actor.tenantId` and every tenant-scoped `Resource.tenantId` are required `string`s, and `assertTenantMatch` now denies when either side is **missing, null, empty or whitespace** — not only when the two differ. The runtime check is not redundant with the types: a tenant arrives from a database column, a session row or a JSON body, and in all three the compiler's belief and the runtime value can differ.
- **The insert paths.** Signup takes the tenant from configuration (`DEFAULT_TENANT_ID`), never from the body. `learner` stamps the profile, its subjects and chapter mastery with **the tenant the access check just passed on**, returned from `authorise()` — so "the row is filed under the tenant that was checked" is true by construction rather than by coincidence. `content` has no insert paths and no tenant, deliberately: the NCERT corpus is CBSE curriculum, identical for every school.
- **The one cross-user write.** `submitLinkCode` refuses a parent and student in different tenants, with the *same* error as an unknown or expired code. A link row spans two accounts and carries one tenant; there is no read-time check that could repair one filed wrongly, so this is the only place it can be decided.

**The resource tenant is read from the DATA, never copied off the actor.** Passing `actor.tenantId` as the resource tenant would satisfy the type and compare a value with itself — a check that can never fail, wearing the shape of one that sometimes does. That is precisely the failure D-073 was raised about, and it would be invisible at every call site. `learner` resolves it through an injected `TenantReader`, wired in `app/routes.ts` alongside `readLinkStatus`, so the cross-module dependency graph stays in one file.

**Cost paid:** about a day, on empty tables, as estimated. **Cost avoided:** the same work on live student rows, with a table rewrite, a lock, and a window in which some reads are tenant-scoped and some are not.

### D-083 · The own-data short-circuit, and the requirement it creates
**Status:** Active — **a requirement for whoever writes account-moving code**

When the authorisation target IS the actor, `learner` and `identity` use `actor.tenantId` as the resource tenant instead of querying for it. That is the one place the two tenants are not independently resolved, and it needs a stated reason and a stated limit rather than silence.

**The reason:** it is the hottest path in the product. Every profile read, every mastery read, every dashboard load is a student reaching their own data, and the alternative is a `users` lookup on all of them to learn a value the session already carries.

**Why it is safe:** the only thing the comparison could catch is a student whose *account* moved tenant while their session was live — and in that case the data moved with them, so a student reading their own profile is not a cross-tenant read whichever tenant they are in. A **parent gets no short-circuit**: their target is somebody else, so the tenant is always read from the data.

**The limit, and it is real:** the session's tenant is TRUSTED for own-data reads. **Moving an account between tenants must therefore revoke its sessions**, the same way a password reset does. Nothing moves accounts between tenants today. Recorded here and in PROGRESS section 7 so that whoever writes that code finds the requirement rather than discovering it.

### D-084 · `audit_log` and `notifications` keep nullable tenants, on the record
**Status:** Active — deliberate, with the mechanism named

Both carry a nullable `tenant_id` (migrations 0005 and 0007) and 0008 leaves them alone. Neither is student-owned data reached through `assertCanAccess`, and — the deciding point — **neither has a writer that knows a tenant**: `audit_log` records system actions whose actor is null by design (D-063), and the in-app notification channel is handed a recipient and nothing else.

Tightening them now would produce NOT NULL columns whose only writer relies on the column default. That is theatre of exactly the kind D-073 rejects, so it is not done. **The mechanism when it is done:** resolve the tenant from the recipient (`notifications`) and from the actor where there is one (`audit_log`), both as a scalar sub-select in the INSERT — and leave `audit_log` nullable for genuinely actor-less system rows. Tracked in PROGRESS section 7.

### D-075 · RESOLVED — the hardcoded migration list is now a lint error
**Status:** **Resolved.** `eslint.config.js`, `MIGRATION_LIST_PATTERNS`.

A **third** instance was found in this wave: `tests/integration/link-code-repository.test.ts` applied `['0000_identity.sql', '0001_link_codes.sql']` by hand. It was green, and green by luck — the repository under test only touches `link_codes`, and its raw-SQL fixtures name their columns explicitly, so the missing `users.tenant_id` never came up. That is how this defect presents every time: not where the list is, but several layers away and much later.

D-075 required the pattern be made *unavailable* rather than corrected again. It now is: a `no-restricted-syntax` selector rejects any **array literal containing a migration filename**, which is the shape of all three occurrences. Naming **one** migration is still allowed — a migration's own forward/rollback test legitimately names its subject. The distinction is not a compromise: one name is a *reference*, a list is a *claim about which migrations exist*, and that is a second source of truth. Verified to fire on a deliberate violation before being trusted (D-005).

A fourth instance was also removed: the test that guarded against this defect had itself become an instance of it, asserting `listMigrations()` against a literal list of eight filenames — so every new migration made it red and the fix was to paste one more string in. It now asserts the *properties*: every `.sql` on disk is returned, in journal order, contiguously numbered from 0000.

### D-081 · The drizzle snapshot chain: what was rebuilt, and what could not be
**Status:** Active — **the alternative is offered, not taken**

`drizzle-kit generate` serialises the TypeScript schema and diffs it against the snapshot of the **last journal entry**. Migrations 0004-0007 were hand-written, so no snapshot was written for them and the chain stopped at 0003. The next `db:generate` would have re-emitted all four as one new file: DDL already applied, presented as pending work, indistinguishable from a legitimate migration.

**Rebuilt:** the snapshot for the last entry, produced by drizzle-kit itself from the current schema and reattached to `0008`. **`npm run db:generate` on a clean tree now emits nothing**, which is the only real proof; `drizzle-kit check` also passes and is exposed as `npm run db:check`.

**Not rebuilt:** per-migration snapshots for 0004-0007. A snapshot is a serialisation of the schema *at that point in history*, and those states were never committed — the repository has no commits at all yet. `introspect` cannot substitute: it reads a database and emits a differently-named schema, so its output would not match what `generate` would have written, and a **wrong** intermediate snapshot is worse than an absent one.

The chain is **linked rather than truncated**: `0008_snapshot.prevId` equals `0003_snapshot.id`, which reads as "0004-0008, together, are the diff from 0003" — exactly what they are. A guard test now asserts that the last journal entry always has a snapshot, that the snapshots present link by `prevId`, and that every forward migration has a hand-written down file.

**The alternative, offered for the user to decide:** collapsing 0000-0008 into a single baseline migration plus one snapshot would give a genuinely gapless chain. It is deliberately not done here because it rewrites migrations already applied to development databases.

### D-206 · The rate limiter moves to `platform`, and the global limit hooks `onRoute`
**Status:** Active

Plan section 6.9's last row — 100 requests per minute for any authenticated caller — was declared in `shared/constants/rate-limits.ts` and enforced nowhere, deferred on "a second module having routes". There are three, and `/me/*` and `/content/*` were unthrottled for anyone holding a session.

**The mechanism moved to `platform/rate-limit`** (fixed window, cache-backed, in-process fallback, all unchanged). It had lived inside `identity` because identity was the only module with routes; the shared plugin lives in `app/plugins`, and `app/` may not import a module's internals. The alternative was a second implementation of the same window arithmetic with its own fallback and its own bugs. `identity.rate-limit.ts` keeps what is genuinely identity's: the key namespace, the key builders (including hashing an email before it becomes a cache key), and its own fallback metric name.

**The plugin registers through `onRoute`, appending itself to each route's `preHandler`.** The key is the user id, so it must run *after* session validation — and every application-level hook Fastify offers (`onRequest`, `preParsing`, `preValidation`, app-level `preHandler`) runs *before* a route's own `preHandler`, which is where `requireSession` lives. An app-level hook would see `request.actor` undefined on every request and throttle nothing: **a limiter that looks installed and enforces zero**, which is worse than none, because nobody looks at it again. `onRoute` also gives the property that matters more — every future module inherits it without opting in. The consequence to know: it must be registered before any route is, and `createServer` does that before both the health routes and the modules.

**No double-counting.** The global counter lives under `rl:global:authenticated:`, identity's under `rl:identity:`. One request increments each exactly once — never one twice, and never one instead of the other. The stricter per-endpoint limit is the one that fires, because it is the one that runs out first. Unauthenticated requests are not touched here: no actor means no key, and falling back to an IP key would put every student in a school behind one NAT into a single bucket.

### D-085 · `POST /links/code` is rate limited, 5 per hour per student
**Status:** Active — closes PROGRESS section 7 open item 2

A student session could mint link codes without bound. The risk is not brute force — that is the parent-side submit limit's job — it is that **every mint retires the previous code**, so a loop invalidates the code the parent is part-way through typing, which is a student denying their own onboarding in the one funnel the product cannot afford to lose. Second: `link_codes` rows are never deleted (they are the audit trail of which code produced which link, D-012), so an unbounded mint rate is an unbounded table.

Keyed by the **student's user id**, not by IP: the actor is authenticated, so the account is the thing to limit. Consumed before the insert, so a rejected request costs a cache round trip and nothing else. The same 5/hour as submit — a student who needs a sixth code in an hour is in a loop, not a flow.

### D-082 · `CORS_ORIGINS` splits into read and write allow-lists
**Status:** Active — closes PROGRESS section 7 open item 1

One list served both the CORS allow-list and the CSRF origin check. Adding a partner origin so a school MIS could GET a read-only report therefore also granted it POST, PUT, PATCH and DELETE across the whole API — silently, in a one-line diff titled "read integration". The person adding it had no way to express the smaller grant, and no reviewer looking at a list of origins could tell which entries were meant to be able to write.

**`CORS_READ_ORIGINS`** feeds the CORS plugin; **`CORS_WRITE_ORIGINS`** feeds the origin check. `APP_URL` is always allowed to write, so trimming the list cannot take the product down.

**Write must be a subset of read, validated at boot.** An origin allowed to POST must be able to read the response to its POST, so a write-without-read grant is not a stricter policy — it is a broken one, where the server acts on the request and the browser then refuses to show the caller what happened.

**Both are required, with no default.** Defaulting write to read would restore exactly the behaviour this splits apart, invisibly; a deployment that has not thought about the distinction fails at boot and thinks about it. The retired `CORS_ORIGINS` is still declared, solely so that a stale one **fails loudly** rather than being ignored — an ignored variable is an operator believing an origin is allowed when it is not.

The payment-webhook exemption and its compensating control (HMAC signature verification, strictly stronger than an origin check for a server-to-server caller) are unchanged, and are re-pinned in the new test file because the split changed which list that hook reads.

### D-086 · Defects and surprises found by tests during this wave
**Status:** Recorded

| Finding | Would have caused |
|---|---|
| `link-code-repository.test.ts` hardcoded its migration list — the D-046/D-072 defect a **third** time | The same class of silent failure: a suite green against a schema missing a column, failing much later and several layers from the cause. Fixed, and the pattern is now a lint error (D-075) |
| The test guarding against hardcoded migration lists **was itself one** | Every new migration made it red for the wrong reason, and the fix was always to extend the literal — a second source of truth maintained by hand, inside the test written to prevent exactly that |
| The default-deny branch of `assertCanAccess` became **unreachable by its own test** | The test passed a malformed resource with no tenant; once a missing tenant became a deny, it was refused by the tenant check and never reached the default-deny line. A green test measuring a different branch — and it surfaced only because `platform/authz` coverage is a 100% gate. Without that gate it would have gone unnoticed indefinitely |
| The `single-tenant behaviour is unchanged` block pinned the exact leniency D-073 removes | Nothing, in the end — its own comment predicted it would have to change and named that as the correct signal. Recorded because the prediction working is the reason the change was cheap |
| The local `.env` had been missing `APP_URL` and `API_URL` since D-015 made them required | `npm run db:migrate`, and every other config-loading script, failed at boot on a developer machine for a reason unrelated to whatever was being run |

---

## Frontend foundation review — 10 August 2026

### D-087 · Five mechanism gaps closed in the frontend plan before any code
**Status:** Active
A review of `02-FRONTEND-IMPLEMENTATION-PLAN.md` found the structure and discipline sound — types sourced from backend contracts, feature slicing with enforced boundaries, the rule of three, state classified into four kinds, streaming edge cases enumerated, the build order putting primitives before screens. The gaps were all **mechanism**, not design, and all five were cheaper to close before the first screen than after twenty.

| # | Gap | Now specified in |
|---|---|---|
| 1 | No authentication or session-state strategy at all | 5.5 |
| 2 | Backend error handling stopped at "401 redirects to login" | 5.6 |
| 3 | The plan described SSE over POST, which the browser API cannot do | 7 |
| 4 | Design tokens named but never given values | 9.1 |
| 5 | Performance, accessibility and visual budgets stated as prose with no enforced number | 10.7 |

Added as **step 0** of the build order, ahead of tooling. Roughly 3.75 days.

**The three worth calling out:**

**`EventSource` is GET-only.** The Foxy endpoint is a POST, so there is no server-sent-events-over-POST in the browser. The implementation is `fetch` plus a `ReadableStream` reader with hand-parsed frames, partial-frame buffering across chunk boundaries, `AbortController` for cancellation, and **reconnection written by us** — `EventSource` provides it free and `fetch` does not. A developer following the original text would reach for `EventSource`, find it cannot POST, and improvise.

**403 arrives before 401 on state-changing requests.** The backend returns the CSRF verdict first, deliberately, because it must not depend on who the caller claims to be. A frontend branching on 401 for "session expired" mishandles it. The error table now states that a 403 on a POST is *not* a logout.

**Redirecting during session bootstrap logs every user out on every refresh.** The most common bug in cookie-session applications. Protected layouts render a skeleton while status is `loading`, never a redirect. Also recorded: a 401 must clear the query cache — on a shared family device, the next user would otherwise see the previous one's data.

### D-088 · Route protection is a user-experience optimisation, not a security boundary
**Status:** Active
The session cookie is bound to the API host, so Next.js middleware cannot validate it without a network round trip on every navigation.

**Decision:** middleware performs a **presence check only**; the authoritative check stays server-side on the API, on every request, where it already lives. A forged cookie passes middleware and is rejected by the API — that is the correct division of responsibility. **No authorisation decision moves to the frontend.**
Role from the bootstrap response selects navigation and theme only. It never decides whether data may be shown.

### D-089 · Components reference semantic tokens, never brand colours
**Status:** Active
Two themes — purple for student, orange for parent — applied by a `data-theme` attribute on the route-group layout. A component hard-coding `purple-600` is a defect: it renders wrong in the parent application. An ESLint rule rejects brand-colour literals in `components/` and `features/`.
Also fixed by the same rule set: the client forbids a harsh red "Wrong", so the incorrect-answer state uses `--info` with "Not yet" copy, never `--danger`. And **evidence labels are a shared union in `shared/contracts/`** — four values, no fifth, and no percentage can be rendered.

### D-090 · Documentation numbering collision resolved
`05-FRONTEND-SEPARATION-PLAN.md` and `05-ROADMAP.md` both claimed 05. The separation plan is now `06-FRONTEND-SEPARATION-PLAN.md`; every reference was repointed.

---

## notify module completion — 10 August 2026

### D-091 · An actor's own tenant is READ FROM `users`, never echoed back from the actor
**Status:** Active — closes a live cross-tenant defect in `notify`

`notify`'s three actor-addressed use-cases — `listForUser`, `markAllRead`, `getUnreadCount` — authorised themselves with `assertCanAccess(actor, action, { kind: 'account', ownerUserId: actor.userId, tenantId: actor.tenantId })`. It was justified in a comment as a hot-path short-circuit: "the target IS the actor, so the two tenants are the same value by definition and a lookup would put a round trip on the hot path of every unread-badge poll."

**That is the exact mistake `can-access.ts` names in its own header and tells callers not to make.** `actor.tenantId` is a *claim* — it arrives on a session row, a JSON body or a cast. Passing it as the resource tenant makes `assertTenantMatch` compare a value with itself: a check that always passes, written in the shape of a check that sometimes fails. The endpoints were tenant-enforced only in appearance, and the D-073 tenancy test on the new module failed for a real reason.

Worth being precise about the blast radius, because it was not what it first looks like. The three methods then went on to **scope their queries by that same unverified value**, so an actor whose claimed tenant differed from their row's tenant got an *empty list*, not somebody else's mail. The damage is prospective rather than current: the only thing standing between a claimed tenant and a real one on those three endpoints was a `where` clause — "enforced by remembering to write the predicate", which is precisely the failure mode `platform/authz` exists to remove. The day tenancy stops being one deployment-wide constant, that is a boundary made of habit.

**Decision:** `authoriseSelf` resolves the tenant through the injected `RecipientReader`, which reads `users` — the same authoritative table `learner`'s `readTenantOfStudent` uses — and passes *that* as the resource tenant. It returns the tenant it checked, so every query below is scoped by the value that was verified rather than the one that was claimed, which makes the repository's tenant predicate belt-and-braces instead of the only belt.

**The cost is stated rather than avoided:** one indexed `users` read per call, including the unread-badge poll. The previous version's speed came from not performing the check. `learner` keeps its self-access short-circuit and is right to — its resource kind is `student-data`, whose rules turn on the parent-child link rather than on identity, and the extra read would buy nothing there. `notify` takes the round trip.

**An account that cannot be resolved denies**, through the guard rather than through an early `NotFoundError`, so "no such account" and "an account in another tenant" produce byte-identical output. A distinct 404 would have been an oracle for account existence.

`markRead` was already correct — it resolves the owner and tenant from the row via `findOwner`. Rather than treat that as a reason to check only the broken method, all four public methods now have separate cross-tenant tests, and a temporary revert of the fix was used to confirm six of the eight fail without it. If one method has the bug, assume the others do until each is separately shown otherwise.

### D-092 · A class-based test fake is subclassed, never spread
**Status:** Active

A test built a failing cache as `{ ...harness.cache, incr: () => Promise.reject(...) }`. `MemoryCache` is a class; its methods live on the prototype; object spread copies own enumerable properties only. The result was an object carrying `incr` and nothing else, which does not satisfy `CachePort` — a type error, and a fake that would have been wrong in a subtler way had it compiled.

**Decision:** extend the platform fake and override the one method. When `CachePort` grows a sixth member the fake grows it for free; an inline object literal compiles on the day it is written and breaks on the day the interface moves. The general rule: a partial fake of a port that has a real fake is a copy waiting to go stale.

### D-093 · The composition-root test asserts an exhaustive module list
**Status:** Active

`buildModules` gained `notify` and `routes.test.ts` still asserted `['content', 'identity', 'learner']`. The failure was correct and the test was the thing that had to change — but only after confirming `notify` was genuinely built, pooled and route-registered, which it was.

Kept as `toEqual` on a sorted exhaustive list rather than relaxed to `toContain`. The assertion's job is to fail when the module graph changes, in both directions: a module added and never registered, and a module deleted. A membership check would only catch the second.

### D-094 · Gaps the notify module was carrying, and what closed them
**Status:** Recorded

| Gap | Would have caused |
|---|---|
| No `notify.routes.test.ts` — the only module without one | The route layer's own claim ("the recipient comes from the SESSION, never the path or body") was never exercised. Service tests construct an actor and hand it in, so a route that started reading a `userId` from the query string would have been caught nowhere |
| No `notify.contract.test.ts` — although `notify.contract.ts` **names it** as the mechanism pinning the wire enum to `NOTIFY_KINDS` | `shared/` may not import from `modules/`, so the kind list is duplicated on purpose. With nothing asserting equality it is not a deliberate decoupling, it is a copy waiting to go stale — producing a kind the server accepts over HTTP and cannot route |
| No test for the weekly digest scheduler at all | The half of §8.7 that *is* finished was unproven: idempotence per (parent, week), that it re-enqueues the following week, that the durable `hasDigestFor` check stops a duplicated RUN which no job key can prevent, and that it refuses loudly when no `DigestSource` is wired |
| No test for dead-lettering after the attempt limit | `notify.delivery.dead_letter` is the one metric in this module that deserves an alert, and nothing proved it was ever emitted. A metric that is silently never emitted looks exactly like the healthy case |
| No test that a non-final failure RELEASES the delivery claim | The retry would have found a stale `in_progress` marker, reported `duplicate`, and **succeeded having sent nothing** — a job reporting delivery of something it never sent, the exact silent failure this module exists to make impossible |
| `worker/jobs/notify-jobs.ts` at 0% coverage | The gate deciding whether the digest handlers are registered *at all* was untested. Registering them unconditionally is a one-line change that leaves every other test green and converts "the digest never went out" into a green job run — an absence is the kind of property that gets reversed by accident |

---

## Corpus extraction — 10 August 2026

### D-095 · MCP cannot carry the corpus; extraction needs a direct connection
**Status:** Resolved
MCP `execute_sql` returns results through the context window. The pilot slice's embeddings are 58 MB — roughly 25M tokens — and a single 200-row batch is about 600K. Batching does not help, and neither does subagent fan-out, because every hop must both receive and re-emit the payload.

Two further routes were checked and closed: `rag_content_chunks` has **no SELECT policy for `anon` or `authenticated`** (only `service_role` write policies), so a publishable key returns zero rows; and anonymous sign-in was rejected because it writes a user row to a live project.

**Resolution:** a session-pooler connection string in `backend/.env`, and a streaming script paginating by keyset straight to disk at zero context cost. The source was read **once**, read-only, and is now finished with.

Also worth recording: the **subagent tool sets differ**. A `general-purpose` agent has the Supabase MCP tools; an `architect` agent does not. An architect agent tasked with the import correctly refused to go looking for credentials and reported the gap rather than working around it — the right call, since the only keys on disk were write-capable production ones.

### D-096 · A real password reached a git-tracked file
**Status:** **Needs action — rotate the source password**
The connection string was pasted into `backend/.env.example`, which is tracked and was already staged, rather than `backend/.env`, which is gitignored.

Remediated: the value was moved to `.env`, `.env.example` restored to a placeholder, and the file re-staged so the index holds only the placeholder. No commit exists and nothing was pushed, so there was no external exposure.

**Standing rule:** `.env.example` documents variable *names* and placeholder shapes. A real value in it is a defect regardless of whether the repository is private. Worth an automated check — a pre-commit scan rejecting anything in `.env.example` that looks like a credential.

### D-097 · The extracted data confirms the measured figures
Every count taken from the source was re-verified **in the written files**, not merely trusted from the query that produced them: 4,686 chunks, 3,791 questions, 639 concepts, 176 edges, 57 misconception patterns. Embeddings are 4,666 at exactly 1024 dimensions plus 20 NULL, with no other dimension present. Questions divide cleanly into 2,746 valid and 1,045 with empty options, with **zero partially-formed cases** — so the exclusion rule has no ambiguous middle. 124 chapters carry chunks, concepts and questions together.

**The pedagogy gap is now confirmed in the data itself:** `hint_level_1` on 0 questions, `solution_steps` on 0, `question_hi` on 210 of 3,791.

---

## Corpus import — 10 August 2026

### D-098 · Four of the five source shapes were wrong, and three failed SILENTLY
**Status:** Resolved — `source-shapes.ts` is now a measurement, not an expectation

`src/shared/corpus/source-shapes.ts` was written from the reconnaissance notes, before `.corpus-extract/` existed. When the importer was first pointed at the real files, four of the five shapes did not match:

| Declared | Actually in the file | What would have happened |
|---|---|---|
| `SourceQuestion.difficulty: string \| null` | a **NUMBER**, 1-5 (1×1,023 · 2×1,816 · 3×937 · 4×8 · 5×7) | `row.difficulty?.trim()` is a TypeError on a number — **death on row 1.** The only one of the four that was loud |
| `SourceChapterConcept.concept_name` | `title` | all **639** concepts skipped, reported as "rejected, no name" |
| `SourceChapterConcept.explanation_en` | `explanation` | every explanation silently null |
| `SourceMisconception.misconception_code` | `pattern_code` | all **57** patterns skipped |
| `SourceMisconception.description_en` / `description_hi` | `description`; **no Hindi column exists at all** | descriptions silently null |

The three silent ones are the point. "0 concepts imported" is indistinguishable from "the source has no concepts", and both read as a content gap rather than as a defect. D-097 verified the *counts* in the written files and did not verify the *keys*, which is exactly the half that was wrong.

**Decision:** the shapes are now derived from a key scan of the real NDJSON, and `tests/integration/corpus-import-real.test.ts` re-reads the actual files and asserts the measured counts — so a future extract with a renamed column fails a test rather than importing nothing. **A source shape is a measurement. Writing one from notes is writing fiction with a type annotation on it.**

### D-099 · The source's difficulty is an integer 1-5; 4 and 5 clamp to `hard`
`DIFFICULTIES` has exactly three rungs. The source has five, and 15 rows use the top two. The mapping is 1 → easy, 2 → medium, **3, 4 and 5 → hard**. Clamping is lossy in a direction that is safe: a question shown as `hard` that was authored as 5 is mis-stated by a degree, whereas excluding it loses content that cannot be re-fetched. Written down in `normaliseDifficulty` rather than hidden in a ternary.

### D-100 · `analyze` is accepted and stored as `analyse`; `infer` and `predict` are not
`analyze` (735 questions) and `analyse` are the same Bloom level, so the alias merges nothing that was distinct — the test every alias in `normalise.ts` has to pass. The pre-existing unit test asserted that `analyze` was **rejected**, a reasonable-looking rule written before anybody counted; it would have dropped **735 of the 2,746 importable questions, a quarter of the bank, over a spelling.** The test was changed and the reason written into it.

`infer` and `predict` (one question each) get no alias. `infer` sits between understand and analyse, `predict` between apply and evaluate, and either guess would be written into data that later drives question selection. They are excluded and counted.

### D-101 · 2,741 questions import, not 2,746 — and the five-row gap is a rule, not a rounding error
2,746 source rows carry four options and a valid index. Of those, **3 carry four options that are not four DISTINCT options** (one is `["1274","1274","1274","1274"]`, which cannot be answered) and **2 carry a non-Bloom level** (D-100). The distinctness rule is open item 4 from D-039 — a CHECK may not contain a subquery and distinctness needs aggregation, so it has always been a module rule with nowhere to live. The import is the first write path that exists, so it lives there now. All 5 ids are in the exclusion report beside the other 1,045.

### D-102 · Primary keys are a deterministic UUIDv5 of the source id
`questions` and `rag_chunks` have `default gen_random_uuid()` and no source column, so a plain INSERT duplicates the whole corpus on every re-run — silently, with no constraint violated, because a random uuid never collides. Every id is now `uuidv5(NAMESPACE, "<kind>:<source id>")`, written with `ON CONFLICT (id) DO UPDATE`.

A `source_id text unique` column was considered and rejected: it changes two tables whose shape was deliberately settled to make this import a straight column mapping (D-040), and the derived uuid needs no extra index and no round trip to translate a source id into ours. The **kind prefix** keeps the six id spaces apart, because a question and a chunk can carry the same source uuid — they come from different tables in a database we do not control.

**The namespace is frozen.** Changing it does not renumber the corpus, it inserts a second complete copy beside it. There is a test pinning the constant for exactly that reason, and an RFC 4122 worked example pinning the algorithm against an external oracle rather than against itself.

### D-103 · The import RECONCILES; clearing the dev seed is not a remembered step
`db:seed` leaves 6 chapters, 120 questions and 180 synthetic chunks, and every verification count is inflated by them in the direction that looks fine — the numbers are simply larger, and nobody notices 180 extra chunks in 4,866. Rather than depend on somebody running a clear command first, the import **deletes every content row that is not in the extract**, inside its own transaction, keyed by the deterministic ids. That also stops a shrinking extract leaving orphans behind.

`npm run db:clear-content` exists for the other case — wanting an empty content schema without importing anything. It is what dropped the stray `chk_probe` table.

### D-104 · The reserve is read from the database BEFORE the transaction, and OR-ed in SQL
`held-out-reserve.ts` is monotonic only if it is **told** what is already reserved; called with its default empty set, a re-import over a chapter that has grown recomputes the reserve and releases questions that have been kept back from practice — the contamination that module exists to prevent, arriving through its own default argument. So the current reserve is read first and passed in, **and** the upsert says `is_held_out = questions.is_held_out or excluded.is_held_out`. Two independent guards, because un-serving a question is impossible.

Measured: **773 of 2,741 held out**, across the 81 chapters that clear 15 valid questions. Chapters below the threshold get none, and are flagged not-demo-ready.

### D-105 · Migration `0001_pedagogy` — three content tables, no tenant, and a limitation written into the schema
`chapter_concepts`, `concept_graph`, `misconception_patterns`. Columns derived from `PlannedConcept` / `PlannedConceptEdge` / `PlannedMisconception`, which were settled by a pure tested module before any DDL existed, so the schema has no opinion of its own to drift from.

**No `tenant_id` on any of the three, deliberately.** D-073 made it NOT NULL on the six tables carrying *student-owned* data. These are curriculum, like `chapters`, `questions` and `rag_chunks`, none of which carries a tenant: Grade 8 Science chapter 4's misconceptions are the same misconceptions in every tenant, and a NOT NULL column whose only writer relies on the default is the theatre D-073 rejected. There is a test asserting the absence, with `students.tenant_id` as its control.

**`concept_graph.concept_code` does NOT join to `chapter_concepts`, and no key is invented.** They are two independently-generated vocabularies — `chapter_concepts` has no code column at all, and the graph's codes are `math_6_ch10`, `m8.rational.ops` and `math.9.ch7.triangles`, three schemes from three generation runs. The only link is the `(grade, subject, chapter_number)` triple, which is what the schema expresses. There is a test asserting that **no foreign key on any `concept_code` column exists**, so the plausible-looking "improvement" fails loudly: it would delete 37 of the 57 misconception patterns, which are human-authored and exist nowhere else now the source has been read for the last time (D-095). `misconception_patterns.is_orphan` is that fact made countable.

### D-106 · An earlier migration's rollback peels the later one off first
Adding 0001 broke `learner-content-migration.test.ts`: the superseded 0002's down migration cannot drop `chapters` while 0001's tables reference it. The tempting repair is `drop ... cascade` in 0002's down file — which would silently delete a LATER migration's tables from inside an EARLIER migration's rollback, and would keep doing so for every migration added after it, moving the failure from a loud error here to no error anywhere. The test now rolls 0001 back first and re-applies it last, which is what a real rollback does and in the order it does it.

### D-107 · The import is covered twice, and only one of the two can run everywhere
`.corpus-extract/` is 77 MB and gitignored — one machine, not CI, not a fresh clone. A test that could only run against it would report "import: covered" while running nothing at all.

- `tests/integration/corpus-import.test.ts` — **always runs**, over a synthetic extract the fixture writes itself, in the source's RAW spellings. Covers normalisation, exclusion, the per-chapter reserve, both retrieval paths, and idempotency by content digest.
- `tests/integration/corpus-import-real.test.ts` — **skips when the extract is absent**, and asserts the measured counts. It is the only thing that can catch a D-098-class defect, because the synthetic fixture is written from the same understanding the importer holds and therefore agrees with it by construction.

### D-108 · 1,199 of 4,686 chunks are exact text duplicates — imported, reported, NOT deduplicated
25.6% of the corpus is duplicated: the same NCERT passages were ingested twice under different `chapter_title` conventions (`'Science - Chapter 10'` and `'The Human Eye and the Colourful World'` are the same Grade 10 chapter). Both copies land under the same chapter row, so nothing is mis-filed — but they compete for the same top-k slots, and the manual vector query returned the same passage twice in its top six.

**Not deduplicated by this import.** Dropping rows to make a number look better is the one thing an import must never do silently, and "which copy is canonical" is a retrieval-quality decision that belongs with the threshold calibration in build step 8, where it can be measured rather than guessed. Recorded as an open item — and it means the effective distinct corpus is ~3,487 chunks, which is the number any coverage estimate should use.

### D-109 · The dev database's migration ledger predated the baseline collapse
`npm run db:migrate` reported "Migrations applied." and applied nothing: the local database still carried the nine ledger rows from the superseded 0000-0008 chain, whose recorded timestamps are LATER than the collapsed baseline's, so drizzle skipped 0001 as already-past. `0001_pedagogy`'s journal `when` was set above the last applied row.

Worth knowing before the next migration lands on any database that predates the collapse: **a "Migrations applied." that applied nothing looks exactly like one that applied everything.** The check is the catalogue, not the exit code.

---

## practice module — 10 August 2026

Build step 11. Migration `0002_practice`, `src/modules/practice/`, `platform/tx`.
D-110..D-121. These implement D-056, D-057 and D-058, which had been settled in
writing since 9 August and had never been executed.

### D-110 · `question_responses` is RENAMED to `practice_responses`, never dropped and recreated
**Status:** Active — executes D-057

D-057's words are "one table, `practice_responses` … `question_responses` is
dropped". The table is empty — nothing has ever written to it — so a drop would
have been harmless today. It is a rename anyway, for two reasons.

A migration whose safety depends on a table still being empty is one nobody can
re-read and trust. The reasoning that makes it safe is invisible in the SQL, and
the next person to copy the pattern will copy it onto a table that is not empty.

And a recreate would have silently discarded every `COMMENT ON COLUMN` the
baseline attached to the five evidence columns — the only place several of those
rules are written down at all (D-065). There is a test that reads
`col_description` back out of the catalogue and asserts the text survived.

`session_id` is added `NOT NULL` with no default, which requires the table to be
empty. A `DO` block at the top of the migration raises a NAMED error saying what
to backfill if it ever is not, rather than letting the constraint violation
arrive with no explanation.

**A finding, from the catalogue rather than from the SQL.** drizzle-kit renames
the table and every constraint it TRACKS — but an inline single-column PRIMARY
KEY has no name in the schema definition, so the implicit
`question_responses_pkey` was not among them. Left alone it is a constraint named
after a table that no longer exists, invisible to `db:generate` (which cannot see
a name it never recorded) and therefore permanent. The rename is hand-added to
the migration and the down file, and the migration test reads
`pg_constraint` rather than the migration it is testing.

### D-111 · `submitAnswer` accumulates on the session; only `submitSession` writes `practice_responses`
**Status:** Active

The client's session has an answer step and a submission step, and §8.6 requires
the responses, the session score, the XP ledger entry and mastery to land in ONE
transaction. Those two facts are in tension: if `submitAnswer` wrote a response
row, part of the submission would already be committed before the transaction
opened, and "all of it lands or none of it does" would be false by construction.

**Decision:** answers accumulate in `practice_sessions.answers`, a jsonb
accumulator, and submission MATERIALISES them into `practice_responses` inside
the transaction. `submitAnswer` performs one bounded UPDATE with
`where submitted_at is null`, so an answer that races a submission is refused
rather than modifying a completed session.

The cost is stated rather than hidden: the in-flight answers are denormalised
for the life of the session, and a session abandoned before submission leaves no
response rows. That is the correct outcome — an abandoned session is not
evidence — and it is why `practice_sessions` keeps its own row from the moment
the questions are drawn.

### D-112 · An opaque `TransactionToken`, because D-056's executor cannot legally cross the boundary
**Status:** Active — resolves the gap between D-056's design and §7.4's enforcement

D-056 says `platform/db` exports an opaque `Executor`, that a public module
function takes one, and that `modules → platform` is an allowed edge. That is
true of the ARCHITECTURE and false of the ENFORCEMENT: the `no-restricted-imports`
rule bans `@/platform/db` from every module file that is not a `*.repository.ts`,
type-only imports included. `practice.service.ts` and `learner.service.ts` cannot
name a drizzle executor at all.

Widening the lint rule was rejected. It is what stops a service quietly
acquiring a query, and it has already caught real violations.

**Decision:** `platform/tx` exports `TransactionToken` — an interface branded
with a `unique symbol` that is declared and never exported, so it is
unconstructible outside `platform/db` and carries no methods. `platform/db`
exports `wrapExecutor` / `unwrapExecutor`, reachable only from a repository.

The result is stronger than what D-056 asked for: a service can HOLD a
transaction and hand it to another module, and still cannot run a statement with
it. The boundary is expressed in the type rather than in a convention.

`practice.repository.withTransaction` opens the transaction and hands the token
up; the SERVICE decides what is inside it, including the call to
`learner.updateMastery`. No repository opens a transaction it does not hand back.

### D-113 · `learner.updateMastery` gains an optional executor, and it is the only method that does
**Status:** Active

`chapter_mastery` belongs to `learner`, and `practice` must write it inside its
own transaction. One optional `executor` on `UpdateMasteryInput`, threaded to one
repository method, is the whole change to that module.

Deliberately not applied to `createProfile`, which still opens its own
transaction: it is atomic on its own and nothing needs to enlist it. A module-wide
"every write takes an executor" refactor would have been a larger diff arguing for
a generality nobody needs yet.

### D-114 · `remediate_general` is a SEPARATE decision from `remediate_misconception`
**Status:** Active — a consequence of D-077

The client's Screen 7 branch names four outcomes. `decideNext` returns five.

"Incorrect with a known misconception" requires a code on the chosen distractor,
and `questions.distractor_misconceptions` is NULL on all 2,741 imported questions.
Collapsing the two would make the content gap INVISIBLE: the funnel would report
misconception-driven remediation firing on every wrong answer, the metric would
look healthy, and nobody would ever author the codes that would make it true.
Two decisions makes the gap countable.

### D-115 · The hint ladder degrades; it never invents a hint and never reveals the answer
**Status:** Active — a consequence of D-077

`hint_level_1..3` and `solution_steps` are NULL on all 3,791 source questions, so
four of the client's five rungs have no data. `resolveHint` reports
`available: false` with a REASON, and the reasons are distinguished:
`not_authored` (content to be written) versus `would_reveal_answer` (a one-step
solution, where the "partial step" IS the answer) versus `above_ladder` (a caller
error). They need opposite fixes, and one reason for all three would hide the
content gap behind what looks like a bounds check.

The no-reveal rule is STRUCTURAL rather than reviewed: `QuestionHints` has no
field for `correct_index`, `explanation` or `options`, so no rung can serve them
even by mistake. The partial-step rung serves `steps[0]` and only when there is
more than one step.

**Today the service supplies an all-null `QuestionHints`, so every question
reports zero available hints.** That is the honest state and it is a seam, not a
stub: when the pedagogy generation pass of 05-ROADMAP.md §6 authors the columns,
the rungs light up with no change to the ladder or to the wire contract.

### D-116 · `evidenceLabel` requires two attempts before it will say `strong`
**Status:** Active

The label is one of four words and never a percentage (§8.7's rule, applied one
layer earlier). `attempts` is a parameter, and this is the only place it changes
the answer: a single 100% reads `developing`, not `strong`. One good session is
evidence of one good session, most of all for the questions a student happened to
find easy. Without this rule the parameter would be decoration.

`not_assessed` exists so the system can say "we do not know yet" rather than
rounding an absence up into a judgement, and a parent screen should show it far
more often than product instinct expects.

### D-117 · Spaced retention is SM-2, not FSRS
**Status:** Active

05-ROADMAP.md §6 permits either. FSRS's parameters are FITTED to a review history
and there is no review history yet, so shipping it with published defaults would
be SM-2 wearing a more impressive name plus seventeen constants nobody here can
justify. SM-2's three numbers can each be explained in a sentence, which is what
makes the schedule something a teacher can be shown.

Two sub-decisions. **A failed review does not reduce the ease factor** (SM-2 as
published): the quality-based adjustment already handles a poor-but-passing
answer, and compounding a reset on top of it drives a struggling student to the
floor after two bad days. **The ease factor is rounded to two decimals in the
domain**, matching `numeric(4,2)`, because a value that differs between what the
domain computed and what comes back out of the column compounds across reviews
into a different interval — invisibly, since both numbers are plausible.

### D-118 · Mastery moves by an exponential moving average, and the rate is one number
**Status:** Active

`chapter_mastery.mastery_score` is a LEVEL, and the learner repository writes it
outright, so somebody has to decide what the new level is. "The latest score IS
the mastery" makes it as noisy as a six-question sample — one unlucky session
takes a student from strong to needs-another-session, a parent sees it, and the
number stops being believed. A full running mean makes recent evidence weaker
than old evidence forever, which is backwards for a measure whose job is to say
where a student is NOW.

`MASTERY_LEARNING_RATE = 0.4`. IRT calibration (roadmap §6, deferred) replaces it
once there is enough response data to fit one; until then a stated simple rule
beats an unfitted sophisticated one.

### D-119 · Today's Mission has no encouragement branch
**Status:** Active

Every reason string is built from the candidate's own row — days overdue from
`practice_retention.due_at`, the attempt count and evidence LABEL from
`chapter_mastery`, the chapter number from `chapters` — in both languages, at the
point of construction (P7, and `notify`'s lesson that an optional Hindi field is
an empty Hindi field in production).

The single fixed string in the file is `nothing_available`, which says plainly
that nothing is due and nothing is weak. That is honest; a generic
encouragement in its place would be the thing a student reads twice and then
stops reading.

**Days, not dates.** A formatted date needs a timezone and a locale, and neither
is this layer's decision. "3 days overdue" is the same fact in both languages and
in every timezone the product ships to.

### D-120 · The three legacy migration tests PEEL 0002 off before they run
**Status:** SUPERSEDED by D-126 — the peel was the defect, not the fix

`foundation-hooks-migration`, `tenant-not-null-migration` and
`learner-content-migration` apply the CURRENT set and then exercise the
SUPERSEDED 0002-0008 chain, which names `question_responses` throughout. After
0002_practice they broke — correctly.

Rewriting their assertions to the new name would have made them claim to test SQL
that does not mention it; editing the superseded files would have destroyed the
oracle `baseline-collapse.test.ts` diffs the baseline against. Each now applies
`0002_practice.down.sql` in its `beforeAll`, which is what a real rollback does
and in the order it does it.

### D-121 · Two anti-cheat findings that only a real submission surfaced
**Status:** Active — worth knowing before writing any test that submits a session

**A perfect score can trip the "all the same index" rule.** If every question in
a session happens to have the same `correct_index`, a completely honest full-marks
attempt stores that index four times and rule 2 fires. The rule is behaving
exactly as specified — it cannot distinguish that from a tap-through — but it
means a fixture whose questions all answer to option 1 makes every scoring test
in the file assert on an INVALID session, and the symptom is a score of 0 with no
obvious cause. The service fixtures now vary `correct_index` per question and
state it in the question text.

**A shuffle map that reorders can still fix a position in place.** `[0, 3, 1, 2]`
is a genuine reordering whose first element is unmoved, so a canonical-index test
that taps position 0 proves the translation exists exactly as well as no
translation does. The test now finds a position the map actually MOVED and
asserts on that; the precondition is asserted first, so the test fails loudly if
the map ever becomes the identity rather than passing vacuously.

### D-122 · `retrieval` and `parent` are constructed in `app/routes.ts`; only one of them registers routes
**Status:** Active

Both modules were built and neither was wired. `parent` had its import landed and
its construction missing — the type error that surfaced it was `Modules.parent`
being required and absent. `retrieval` had nothing at all.

Both are now members of `Modules`, which is total, so neither can be dropped from
a real deployment without a compile error. **`retrieval` is deliberately absent
from `registerRoutes`.** It has no HTTP surface: a retrieval endpoint is an
unauthenticated way to page through the corpus, and a caller who chose the
filters could choose a grade the student is not in. It is reached in-process by
`foxy`. `routes.test.ts` states that in a comment beside the exhaustive module
list, because "built but not registered" reads exactly like an oversight.

Pools follow §3.1: `parent` on `core`, `retrieval` on `ai` — not `core`, even
though `content` owns `rag_chunks` and runs there. The pool follows the CALLER's
cost profile, and the `ai` pool is the only one carrying `hnsw.ef_search = 100`
(D-049).

`retrieval`'s `ChunkReader` takes ids and no actor, so `app/routes.ts` supplies a
named `RETRIEVAL_ACTOR`. That is not a bypass: `content` is the one resource kind
in `platform/authz` that is neither tenant-scoped nor owned — any authenticated
actor may read, nobody may write — so the actor grants exactly what every
logged-in student already has. Threading the real caller through would be
decorative: hydration is a primary-key lookup of ids retrieval's own SQL already
hard-filtered by grade and subject, and an actor passed only to satisfy a check
that cannot fail reads as a boundary while being none. The authorisation that
matters for a retrieval belongs to `foxy`, which has a request and a session.

### D-123 · The embedding adapter is a BOOT FAILURE in production without a key, not a warning
**Status:** Active

`retrieval` needs an `EmbeddingProvider` and the container had none, so one was
added: Voyage when `VOYAGE_API_KEY` is set, the deterministic fake otherwise.

The variable is OPTIONAL in `config.schema.ts` and REQUIRED by an explicit check
in `createContainer`. Making it mandatory in the schema would force every test
fixture to invent a fake key, and a fake key that parses is exactly the thing that
would then reach Voyage.

The check throws rather than warns because the degraded mode has NO SYMPTOM. The
corpus's 4,686 chunks were embedded by `voyage-3`; a query embedded by the fake
lands in an unrelated vector space where cosine distance is arithmetic that still
succeeds and no longer means anything. Every answer would be grounded in fifty
confident, wrong passages — no error, no timeout, no metric. A warn line in a log
nobody reads is not a defence against that.

### D-124 · Drizzle's `db.execute()` returns timestamps as WIRE STRINGS, and `parent` shipped a `Date` that was not one
**Status:** Active — check this in every repository that uses raw `sql`

`parent.repository` declared `generated_at: Date` on its row type and passed the
value straight to `DigestRecord.generatedAt`, also typed `Date`. It was the string
`'2026-08-10 14:01:20.396047+00'`. Measured: node-postgres's own client parses
`timestamptz` and `date` into `Date`, but drizzle's `db.execute()` runs raw SQL
and does its column mapping in the query builder instead, so a raw execute yields
the wire text.

**Nothing was going to catch it.** `db.execute<Row>` is an unchecked CLAIM about
the row shape, so the compiler believed `Date` all the way out to the module's
public type, and the value serialises to JSON perfectly well — as a subtly
different string from the ISO timestamp every other endpoint emits. It fails only
when somebody calls a `Date` method, and the first caller to do so was this
module's own new test.

Two traps in the repair, both hit before being fixed. `new Date(s.replace(' ','T'))`
still returns `Invalid Date`, because Postgres writes a two-digit offset (`+00`,
not `+00:00`) — and `Invalid Date` is WORSE than the string it replaced, because it
satisfies `instanceof Date`. And the naive fix for the sibling `date` column,
`String(value).slice(0, 10)`, turns a `Date` into `'Mon Jun 0'`: still a string,
still ten characters. The tests assert `Number.isNaN(getTime())` and a
`YYYY-MM-DD` regex for exactly these two.

The transcript path carries the same widening even though `chat_sessions` does not
exist yet, so the defect does not reappear on the day `foxy` ships.

### D-125 · `authoriseSelf` was an unenforced guard, found by mutation and now pinned
**Status:** Active — the fifth "installed and enforcing nothing" finding

Each of `parent`'s guards was deliberately broken, one at a time, in the source,
and the suite re-run:

| Mutation | Caught? |
|---|---|
| `authoriseChild` resource tenant echoed off the actor (D-091) | YES — 4 tests failed |
| link status hardcoded to `'approved'` | YES — 12 tests failed |
| worker's cross-tenant `if` removed | YES — 2 tests failed |
| **`authoriseSelf` resource tenant echoed off the actor** | **NO — the suite stayed green** |

`getChildren` is the only caller of `authoriseSelf`. Its resource is
`{ kind: 'account', ownerUserId: actor.userId }`, so the OWNERSHIP rule is
trivially true for a self-check — which means the tenant comparison was the only
thing the function did, and echoing the actor's tenant turned the whole method
into a no-op wearing the shape of a boundary. Precisely D-091, in the one method
with no test standing behind it.

**What isolating it required.** A parent WITH a child masks the mutation:
`readChildProfile` calls learner's `getProfile`, which runs its own independent
tenant check and refuses. Defence in depth doing its job — and hiding which layer
was load-bearing. The pinning test therefore uses a CHILDLESS parent, for whom the
second layer is never reached, plus a same-tenant control so the assertion is
about the tenant rather than about having no children.

The mutations are institutionalised in
`src/modules/parent/__tests__/parent.authz-mutation.test.ts`, which builds the
module with each guard broken and asserts the break is OBSERVABLE. A green suite
proves the allow path works; it says nothing about whether the deny path is
reached. This file is what answers the second question.

### D-126 · Migration tests assert schema PROPERTIES against the discovered set; they never name a chain
**Status:** Active — supersedes D-120, and is the D-075 rule applied to its own guard

D-075 banned an ARRAY LITERAL of migration filenames. Two tests evaded it by
writing the same list VERTICALLY — ten `readDownMigration('0007_…')` calls in
sequence — and were then patched by hand twice each, most recently by D-120's
peel. `0003_parent` broke them again. Ten hand-ordered names IS a list; writing it
downward does not change what it claims.

**Three changes.**

1. `foundation-hooks-migration` and `learner-content-migration` no longer peel
   anything. They apply `applyAllMigrations()` whole and assert PROPERTIES of the
   result: tenancy is real and defaulted, the role CHECK is wide while signup is
   narrow, the evidence columns are documented and constrained, notifications
   require both languages, jobs deduplicate. Correct for any number of migrations.
   The responses table is named `practice_responses`, because that is what the
   product ships (D-057); the superseded SQL that spells it `question_responses`
   is still exercised verbatim by `baseline-collapse.test.ts`, which is the only
   job those files still have.

2. **Two tests DELETED, not repaired.** `every foundation migration rolls back and
   re-applies` and `0002_learner_content — rollback` rolled the superseded chain
   backwards by name. Those migrations no longer exist as discrete steps — the
   deployed history is `0000_baseline` — so nothing will ever run those down files
   against a real database. A test whose subject cannot occur asserts a fiction and
   can only cost maintenance. Both deletions carry their reason at the bottom of
   their own file. The PROPERTY they were reaching for now lives, generalised, in
   `tests/integration/migration-round-trip.test.ts`: apply the discovered set,
   reverse it, assert `public` holds ZERO tables, re-apply, and diff the catalogue
   against the first apply. It needed no edit for `0003_parent` — which had had no
   rollback test at all — and will need none for the next migration.

3. The `tableNames()` `toEqual([…25 strings])` assertion is gone too; it was the
   same defect in a table-shaped costume. It now compares the applied schema
   against the tables the Drizzle barrel DECLARES, via `getTableName`. Those are
   two independent declarations of the schema that agree exactly when somebody
   remembered to run `db:generate` — a real drift check instead of a paste target.

**The lint rule was strengthened, since the old one demonstrably could not see
this.** `migrations/no-migration-chain` counts DISTINCT migrations named per file
(`0002_practice.sql` and `0002_practice.down.sql` count as one) and errors above
two. Two is a migration test naming its SUBJECT plus a PREREQUISITE, which
`pedagogy-migration` and `practice-migration` both legitimately do. Three is a
chain, and a chain is a claim about which migrations exist. Verified to fire on a
real violation before being trusted (D-005): pointed at the pre-rewrite
`foundation-hooks-migration` it reports 6.


---

## Pedagogy foundations — 10 August 2026

### D-127 · The concept graph is traversable at CONCEPT level and only reportable at CHAPTER level
**Status:** Active — the constraint `modules/knowledge` is built around

D-077 recorded that `concept_graph.concept_code` does not join to
`chapter_concepts`. Building the reader forced a sharper reading of what that
does and does not prevent, and the two halves came out differently:

- **Internally the graph is sound.** All **176** prerequisite references resolve
  to a real `concept_code` — measured, **zero dangling**. The column carries no
  foreign key, so this was an open question; it is now an answered one. Traversal
  over concept codes is therefore exact, not best-effort.
- **Outward it reaches nothing but a chapter.** `chapter_concepts` has no code
  column at all, so the only key linking an edge to content is `chapter_id`.

So the module traverses codes and REPORTS chapters, and the return types say so
(`ChapterNodeId` is what a learning path is made of). **No key is invented** — no
fuzzy title match, no string-munged code, no lookup table. A future change that
"fixes" the join by manufacturing one is the regression this entry exists to
prevent.

### D-128 · Projecting the graph onto chapters CREATES cycles that the concept graph does not have
**Status:** Active — **the finding of this build step**

Measured on the imported corpus: the concept-level graph is **acyclic — 0 cycles
over 176 edges.** Its chapter projection has **three**, all in grade 7
mathematics.

The cause is **two authoring schemes layered on the same chapters.** Grade 7 (21
rows) and grade 8 (19 rows) mathematics carry both a COARSE scheme — `math_7_ch5`,
one code per chapter — and a FINE scheme — `m7.geometry.triangles`, several codes
per chapter. No other grade or subject has the fine one. Each scheme is
individually consistent; the fine one orders concepts in a way that disagrees with
the coarse one's chapter order, and collapsing both onto `chapter_id` merges two
independent authorings into a graph that contradicts itself:

```
7/math/ch8 -> ch7 -> ch5 -> ch4 -> ch3 -> ch8
  via math_7_ch8 needs math_7_ch7                    (coarse)
  via m7.geometry.triangles needs m7.geometry.angles (fine)
  via m7.decimals.concept needs m7.fractions.concept (fine)
```

**Decision: report the cycle, never repair it.** Both edges in a projected cycle
are TRUE statements about concepts, so dropping one is an editorial decision the
code has no standing to make — and the dropped edge would be unrecoverable. The
walk returns the closed chapter path that demonstrates the contradiction, so a
human can decide which scheme wins. `findLearningPath` is cycle-safe by
construction (iterative three-colour DFS, no recursion).

**A second, quieter trap:** 22 of the 176 edges join two concepts in the SAME
chapter. Under projection those become chapter self-edges, and a self-edge makes
every topological sort report a cycle that is not one. They are dropped, and the
count is returned rather than swallowed.

### D-129 · Graph coverage is measured against every chapter IN SCOPE, and "orderable" is part of it
**Status:** Active

The denominator is every chapter in the grade and subject, never the chapters the
graph already knows about — the second denominator always reports 100% and is the
reason a thin graph looks finished.

Measured, grades 6-10 mathematics and science (the whole imported corpus):
**128 of 137 chapters carry a graph row (93.4%);** the nine that do not are named,
not just counted.

`orderable` is reported as part of coverage rather than as a separate health
check, because a grade whose chapters are all covered but whose projection
contains a cycle cannot produce a learning path — its effective coverage for the
one feature the graph exists to serve is zero. **Grade 7 mathematics is exactly
that case: 15 of 15 chapters covered, and not orderable.** Reporting
`chaptersWithGraph: 15` and stopping would rank it the best-covered grade in the
corpus.

`canPlanFor` exists for the same reason in the other direction: most grade 7
chapters are not on the cycle and can still be given a path, and refusing the
whole grade because three chapters contradict each other would hide a working
feature behind a data defect.

### D-130 · `platform/rules` carries the mechanism and no business rule; a version is added, never edited
**Status:** Active

The rules engine is `platform/`, so it holds no threshold, no subject, no grade
and no student. Facts and outcomes are generic; the first consumer (`signals`)
supplies its own.

Three properties, each with the failure it prevents:

1. **Deterministic — the instant is an ARGUMENT, never a clock read.** A
   `Date.now()` anywhere in the directory makes yesterday's decision
   unreproducible, which makes the audit trail decorative rather than evidential.
2. **Every evaluation records `code@version`.** That stamp is the difference
   between "the system flagged this student" and a claim that can be argued with,
   replayed and rolled back. The evaluator stamps from the rule object it actually
   ran — a rule that stamped itself could lie about its own version.
3. **A duplicate `(code, version)` is rejected at construction.** Two rules
   sharing a stamp would retroactively make every decision ever recorded under it
   ambiguous — silently. A boot failure is a bad morning; that is a bad quarter.

**Versions are ADDED, never edited.** A threshold change is a new version with a
later `activeFrom`, which leaves last month's decisions explainable by the numbers
that actually produced them. Version integers are per code and are not semver:
there is no backwards-compatible change to a rule.

Two consequences worth stating. `evaluateAll` does NOT short-circuit on first
match and retains `matched: false` — "rule X saw these facts and did not fire" is
the most common question asked of a rules engine, and a filtered list cannot
answer it. And a code whose earliest version begins after the instant is SKIPPED
rather than failing the batch, so a backfill over historical facts is not blocked
by a rule shipped last week; asking for that code BY NAME still throws, because
that caller asserted it applies.

### D-131 · `signals` reuses `practice`'s anti-cheat through an INJECTED EDGE with no default
**Status:** Active

"Unusually fast completion" is defined relative to the anti-cheat floor
`practice` already authored and tested (`MIN_AVERAGE_MS_PER_QUESTION = 3000`).
`signals` needs the floor and the verdict, and takes both through an
`AntiCheatEdge` port.

**There is deliberately NO DEFAULT.** A missing edge is a compile error, because a
default would be a second copy of a constant — and two copies of a threshold
drift, silently, with the symptom being a signal that quietly stops agreeing with
the rejection it is defined to sit just above. The domain tests build the edge
from `practice`'s REAL functions rather than a stub, so a divergence fails a test
instead of shipping.

The rule sits in the band the system does not otherwise look at: **below 3s the
attempt is already rejected and scored zero** (re-reporting it would double-count
and send a teacher after something already handled); **between 3s and 6s it is
accepted, scored and counted toward mastery** while being faster than a CBSE MCQ
can be read.

**Consequence for whoever wires this:** `practice/index.ts` does not currently
export `MIN_AVERAGE_MS_PER_QUESTION` or `validateAttempt`. One additive export
line is needed there before the composition root can build the edge. Left to
`practice`'s owner rather than done here, since `modules/practice/` was out of
scope for this change.

### D-132 · Anomaly evidence is `Record<string, number>`, and that is a privacy mechanism
**Status:** Active — P13

Every signal has to explain itself, and the cheap way to do that is a free-text
field — which is how a name, a chapter title, a typed answer or a phone number
ends up in a notification payload, a log line and an analytics export.

Constraining evidence to NUMBERS makes that **structurally impossible rather than
a matter of review discipline**: there is no way to put a name in a `number`. The
single `reason` string is assembled from those numbers and fixed words only, and
is asserted to contain no uuid and nothing matching
`/name|email|phone|address|dob|parent|guardian|password|token/i` — including over
the whole serialised payload.

The uuids it does carry (`studentUserId`, `chapterId`) are identifiers, not PII:
they mean nothing outside a database that already applies the tenancy guard, and a
signal that could not say who it was about would be unusable. The service's one
log line is counts and stamps only, for the same reason.

The four MVP thresholds are named constants with their rationale written beside
them, in one file a non-engineer can read: `INACTIVITY_DAYS = 7` (the unit of a
school routine; shorter fires on every weekend and every festival),
`MASTERY_DROP_MIN_PERCENTAGE_POINTS = 15` (one question on a ten-question set is
worth ~10 points, so a lower bar fires on noise), `FAST_COMPLETION_FLOOR_MULTIPLE
= 2` (derived from the injected floor, never restated), `STRUGGLE_SCORE_PERCENT =
40` and `REPEATED_STRUGGLE_SESSIONS = 3` (the client's teacher-escalation
trigger — two is two bad days, three is a pattern the student cannot break
alone). **None has been validated against a false-positive rate, because no
student has used the system yet, and each records the observation that would
change it.**

---

## billing module — 10 August 2026

> **Numbering note.** D-150 to D-156 are taken as a BLOCK for `billing`, rather
> than continuing from D-126, because three other modules were being built in
> parallel against this same file. A block avoids two agents both claiming
> D-127; the gap is deliberate and is not a missing decision.

### D-150 · The PAYER and the BENEFICIARY are separate columns, because the commercial model is unresolved
**Status:** Active — the decision the whole module is shaped around

It is not settled whether the product ships B2C (a parent subscribes for their
own child) or as a **B2B school pilot**, in which schools pay and per-parent
subscriptions never ship at all. The cheapest-looking schema —
`subscriptions.user_id` — answers that question **by accident**, and unanswering
it later is a migration across live financial rows plus a rewrite of every call
site that assumed the payer was the actor.

**Decision:** every subscription carries two independent facts.

* `subject_user_id` — whose entitlements this grants. Always a `users` row.
* `payer_kind` plus exactly one of `payer_user_id` / `payer_school_id` — who is
  charged.

`subscriptions_payer_exactly_one_check` makes any other combination
unrepresentable in the database. The second half of that CHECK is the one that
matters: a `school` payer must ALSO have a NULL `payer_user_id`. Without it a
B2B row could carry a stale user payer, and a reconciliation query joining on
`payer_user_id` would bill the wrong party — a defect discovered by an angry
parent rather than by a test.

**The decision itself lives in ONE injected function**, `PayerResolver`,
supplied at the composition root. `billing` never constructs a payer, so it
cannot hard-code one; the B2C answer is `{ kind: 'user', id: actor.userId }` and
the B2B answer looks up the subject's school. A test drives a school-paid seat
end to end, and a second test asserts that a resolver returning `null` REFUSES
the checkout rather than falling back to charging the actor.

The same split runs through `platform/payments`: `CreateSubscriptionRequest`
carries a `payer` AND a `subjectUserId`. The port previously had a bare
`userId`, which is the assumption being removed.

### D-151 · The webhook lives at `/api/v1/webhooks/billing`, NOT the path plan section 8.8 names
**Status:** Active — a defect found in the plan, not in the code

Plan §8.8 writes the endpoint as `POST /billing/webhook`. **That path would have
been broken in production and green in development.**
`app/plugins/origin-check.ts` exempts state-changing requests from the CSRF
origin check by the path pattern `^/api/v\d+/webhooks/` and by nothing else. A
payment provider POSTs server-to-server and sends no browser `Origin`, so a
webhook route outside that prefix is refused **403 — for every genuine
delivery**, which Razorpay then retries for hours while subscriptions silently
fail to activate. Nothing in a local test would have shown it, because a local
test sends whatever headers it is told to.

Two fixes were available: widen the exemption pattern, or name the endpoint so
the existing pattern covers it. The plugin's own header answers that — "the
exemption is a PATH PREFIX and nothing wider… never a loosened pattern" — so the
endpoint moved.

`billing.routes.test.ts` pins **three** properties, not one:

1. the chosen path IS exempt (a delivery with no `Origin` is not 403'd);
2. the exemption is SCOPED — a live request to `/api/v1/billing/webhook` is
   **403**, and `WEBHOOK_PATH_PATTERN.test()` is asserted false for it, so a
   future rename cannot silently reintroduce the failure;
3. the exemption buys nothing without the signature — an unsigned POST to the
   exempt path is still refused.

### D-152 · Five guard mutations were run against the source. All five went red.
**Status:** Active — the sixth "is this enforcement real" audit

D-125 recorded the fifth "installed and enforcing nothing" defect
(`parent.authoriseSelf`). `billing.authoriseSubscription` has **exactly the same
shape**: `kind: 'subscription'` is granted on OWNERSHIP alone, so for a
self-check the ownership rule is trivially true and the tenant comparison is the
only thing the function does. Echoing `actor.tenantId` as the resource tenant
would turn it into a no-op wearing the shape of a boundary.

So each guard was broken in the source, one at a time, and the suite re-run:

| Mutation | Caught? |
|---|---|
| `authoriseSubscription` resource tenant echoed off the actor (D-091 shape) | **YES** — 2 files failed |
| `authoriseSubscription`'s `assertCanAccess` removed entirely | **YES** — 2 files failed |
| `verifySignature` always returns `true` | **YES** — 5 files failed |
| the `ON CONFLICT DO NOTHING` dedupe always reports "inserted" | **YES** — 1 file failed |
| `effectiveStatus` never expires by the clock | **YES** — 3 files failed |

**The first one is the interesting result, and the reason it was caught is worth
recording.** D-125's mutation survived because `parent` had a SECOND,
independent check downstream (`learner.getProfile`) which masked it, and because
the only test used a parent WITH a child. `billing` has no second layer —
`subscriptions` is its own table and nothing else re-checks — so the isolating
test had to be written deliberately: an account whose row is MOVED to another
tenant while the actor keeps claiming the old one, plus a same-tenant control so
the assertion is about the tenant and not about the account existing.

The mutations are institutionalised in
`src/modules/billing/__tests__/billing.authz-mutation.test.ts`, which builds the
service with each guard broken **through its injected seams** and asserts the
break is OBSERVABLE — including that with the signature check defeated, an
anonymous caller can cancel a stranger's subscription with four bytes.

### D-153 · Expiry is COMPUTED at request time; no job decides it
**Status:** Active

A stored status is a claim made when the last event arrived. A row saying
`active` whose `current_period_end` was yesterday is not active — it is a row
nobody has revisited. If a background sweeper were the thing that expired it,
every minute of job downtime would be a minute of free paid access, and a
sweeper that silently stopped would be indistinguishable from a business doing
well.

`effectiveStatus(state, now)` therefore decides, on every `getEntitlements` and
every `/billing/status`, and **nothing is cached in the session** — the same
reasoning as §7 rule 3 for parent-child link revocation. A housekeeping sweeper
that rewrites stale rows is welcome later; it must never become the thing that
decides.

Corollary, and it is not a detail: a NULL `current_period_end` on a granting
status reads as **expired**, not as unlimited. A grant with no expiry is a grant
forever, and the safe reading of a missing end is that it is over.

### D-154 · An entitlement is a positive grant; `free` is a real feature list
**Status:** Active

The natural free tier is "no subscription row, so nothing has restricted you
yet" — free access as the ABSENCE of a denial. That inverts the safety property:
any path that fails to look up a subscription, or throws before it does,
silently grants the free tier, and the day a feature moves from free to paid
every one of those paths keeps giving it away.

`PLANS.free` therefore has an explicit feature list and every consumer asks
`hasFeature(entitlements, …)`. A lost grant is an EMPTY list, which grants
nothing — loud, rather than a working free tier nobody notices is being handed
out. Paid plans are written as `[...FREE_FEATURES, …]`, so "paying takes
something away" is not expressible.

Two lookup functions exist and they behave **oppositely on an unknown code, on
purpose**: `findPlan` returns null and the checkout REFUSES (selling somebody a
misspelt plan takes their money for nothing), while `planOrFree` degrades and
the entitlement path continues (a retired plan code must not lock out a customer
who is still paying).

### D-155 · Financial rows are `ON DELETE RESTRICT`, which makes erasure an ANONYMISE job that does not exist yet
**Status:** Active — a stated, unpaid cost

Every foreign key out of `subscriptions` is RESTRICT, unlike every other
student-owned table in this schema. A subscription is a financial record: money
moved, and a receipt that vanishes because somebody deleted an account is a
reconciliation hole and, in India, a GST-invoice hole. So deleting a user who
has ever been billed **fails loudly**.

The consequence is accepted rather than designed around: account erasure for a
paying user becomes an ANONYMISE operation rather than a DELETE, and that work
does not exist. It is recorded here rather than pre-built, because writing it
before there is a single subscription would be guessing at a retention policy
nobody has set. The harness truncates the billing tables above `users` for the
same reason.

`payment_events.tenant_id` is **NULLABLE**, matching `audit_log` and
`notifications` (open item 8, D-084) and for the same reason: the writer is an
anonymous provider webhook with no actor and no session. The tenant is stamped
FROM THE MATCHED SUBSCRIPTION when there is one and left NULL when there is not
— an event matching nothing genuinely has no tenant, and filling it from the
column default would file cross-tenant noise under whichever tenant happens to
be first.

### D-156 · The Razorpay adapter is fully tested and never called; the fake shares its cryptography
**Status:** Active — and the residue is stated in PROGRESS.md §7

There is no Razorpay account and no key, and there will not be one before this
ships. Two consequences, handled differently:

* **The HTTP half** — `createSubscription`, `cancelSubscription` — is driven
  entirely by a recording fake `HttpClient`. Success, non-2xx, malformed body,
  missing `id`, unmapped plan code: all covered, nothing leaves the machine,
  nothing is charged. What this **cannot** prove is that Razorpay's live
  responses have the asserted shape, which is exactly why every field is
  NARROWED rather than cast — a live response missing `id` fails loudly at the
  boundary instead of becoming a subscription row with an empty provider id that
  no webhook can ever reconcile.
* **The signature half** makes no network call at all, so it is exercised
  against real cryptography. `platform/payments/signature.ts` is shared by the
  Razorpay adapter AND the deterministic fake — same HMAC, same timing-safe
  comparison, same refusal on an empty secret. A fake that accepted any webhook
  would have left every "a forged signature is rejected" test green against a
  service with the check deleted.

Three details that have each been got wrong in published code, and are pinned by
tests: the comparison is timing-safe (with the length checked separately, since
digest length is public); the digest is over the RAW bytes, never a
re-serialised parse; and **an empty secret verifies nothing rather than
everything** — HMAC with an empty key is valid arithmetic an attacker can also
perform, so a deployment that forgot to set the secret would otherwise accept
every forgery with the suite still green.

`RAZORPAY_PLAN_IDS` is a variable rather than a constant because a Razorpay plan
id is created in their dashboard and differs between the test and live accounts.
A hardcoded one means a staging deployment subscribing somebody to a production
plan — a real charge, on a real card, from a test click.

---

## Deployment, CI/CD, backups and alerting — 10 August 2026

Resilience plan §5, §7, §8, §11, §12 and §13, plus the CI/CD and pipeline
isolation requirements of `06-FRONTEND-SEPARATION-PLAN.md`.

**Numbering note:** this block starts at D-140 rather than D-133. Three other
agents were appending to this file at the same time; the gap is deliberate
collision avoidance, not a lost decision. The last three entries were renumbered from D-150-152 to D-160-162 after another agent claimed D-150-156 mid-write — which is itself the hazard this note is about.

### D-140 · The production stack is a SEPARATE compose file with separate volume NAMES, not a profile on the development one
**Status:** Active

The development stack (`backend/docker/compose.yml`) holds the imported corpus in
`foxxy_postgres_data` — 137 chapters, 4,686 chunks, 2,741 questions, hours of
extraction that cannot be re-run cheaply (the source is a live production
Supabase project, read-only).

A `profiles:` overlay or a second `--env-file` on the same file would have made
the two stacks share volume names and container names, and the failure mode is
`docker compose -f the-wrong-file down -v`.

**Decision:** `docker/compose.prod.yml`, project name `foxxy-prod`, and every
volume named `foxxy_prod_*`. The isolation is not a convention anybody has to
remember; the names simply do not collide. The development compose file was not
edited at all.

### D-141 · Postgres and Valkey are on an `internal: true` network with NO published ports
**Status:** Active

The most common way a self-hosted database is compromised is a `ports:
5432:5432` line left in from development. `internal: true` means the network has
no route to or from the internet, and there is no `ports:` key on either data
service. Operator access is `docker compose exec`, which needs no exposed port.

The product frontend is on the `edge` network ONLY: it talks to the backend from
the BROWSER, cross-origin with credentials, so it has no reason to reach Postgres
and therefore cannot.

### D-142 · The SSE route has its own proxy policy, and the ORDINARY routes were deliberately not relaxed
**Status:** Active — the highest-risk item in the deployment

A reverse proxy's defaults are written for request/response, and every one of
them is wrong for a token stream: buffering holds the first token until the
answer is finished, gzip re-introduces the same delay through its own buffer, and
a 15-60s read timeout severs a long answer mid-sentence.

**Every symptom of getting this wrong points at the language model, and the
language model is fine.** That is why it is called out here rather than left to
whoever configures the proxy.

**Decision:** in `docker/caddy/conf.d/20-api.caddy`, a `@sse path /api/v1/foxy/*`
matcher with `flush_interval -1` (buffering off), a 300s upstream read timeout
(at or above the plan's 120s minimum, and above §4's 60s stream budget so the
APPLICATION's timeout always fires first — the application can send a typed error
and the proxy cannot), a 30s `response_header_timeout`, and NO `encode`
directive. Ordinary API routes keep a 30s read timeout and keep compression.

The matcher is deliberately WIDER than the stream route — every `/api/v1/foxy/*`
path, not one exact URL — because `foxy` is being built now and pinning an exact
path produces a config that is correct on the day it is written and silently
wrong afterwards, with the failure appearing as buffered streaming.

**The one honest limitation:** Caddy's server-level `write` timeout applies to
the whole listener, which all three hostnames share, so a value safe for ordinary
routes would sever every stream. It is therefore left unset and per-route
bounding is done UPSTREAM (`transport http { read_timeout }`). What is not
bounded is a slow CLIENT reading an ordinary response — the cheaper of the two
exposures, and it is stated in the Caddyfile rather than discovered later.

CI asserts both settings by name. `caddy validate` is perfectly happy with a
config that buffers: the result is a valid file and a broken product.

### D-143 · Proxy ownership is enforced in three layers, because a comment enforces nothing
**Status:** Active

`06-FRONTEND-SEPARATION-PLAN.md` requires that no application pipeline can write
the proxy configuration or restart the product. Implemented as:

1. `docker/caddy` is mounted `:ro` — Caddy cannot rewrite its own config.
2. `docker/deploy-app.sh` is the only deployment entry point an application
   pipeline has. Its service list is an ALLOW-LIST keyed by app name; there is no
   argument that reaches `caddy`, `postgres`, `valkey` or `backup`, and it uses
   `--no-deps` — without which `docker compose up -d website` recreates
   everything `website` depends on, which is exactly the mechanism by which a
   marketing deploy takes the product down.
3. `.github/CODEOWNERS` requires an infrastructure review on `docker/caddy/**`,
   `docker/compose.prod.yml`, `docker/backup/**` and `.github/**`.

Layers 1 and 2 are mechanical. Layer 3 depends on branch protection having
"require review from Code Owners" enabled — a repository SETTING, not a file.
Recorded as a known gap: without that setting, CODEOWNERS is documentation.

### D-144 · Path-scoped per-app workflows AND a single fan-in gate, reconciled by a change-detection job
**Status:** Active

The two requirements pull in opposite directions. Per-app workflows with their
own `on: push` path filters report "skipped" when the paths do not match, and a
REQUIRED check that never runs blocks every pull request forever.

**Decision:** each app's CI is its own file (`backend-ci.yml`, `frontend-ci.yml`,
`website-ci.yml`) declared `on: workflow_call`; `ci.yml` runs a `changes` job and
calls only the ones whose paths moved. One required check, `ci-gate`.

Two details that are the difference between a gate and a decoration:

- the gate is `if: always()` and inspects `needs.*.result` explicitly, because
  `needs:` alone makes it SKIP when an upstream job skips, and a skipped required
  check reports as neutral, which reads as green;
- an unknown diff base (first push, force-push) runs EVERY app. A
  change-detection failure must never be read as "no app changed".

### D-145 · Migrations run as an explicit step, and the step CHECKS THE CATALOGUE
**Status:** Active — implements the D-109 lesson mechanically

Never on boot: with two replicas that is two concurrent migrators racing on one
lock, and a failed migration becomes a crash-loop that also takes the service
down. As a discrete step, a failed migration leaves the OLD version serving. The
compose service is under `profiles: [migrate]`, so `up -d` does not start it.

D-109 is why the CI step does not stop at the exit code: `db:migrate` printed
"Migrations applied." and applied NOTHING, because Drizzle skips a migration
whose journal timestamp precedes the last applied ledger row. The CI step
therefore counts tables in `information_schema` afterwards and fails below a
floor.

`backend/scripts/ops/migration-round-trip.ts` is the second half: forward,
rollback to a provably EMPTY public schema, forward again, catalogue diffed. It
exists alongside the vitest test of the same property because they run against
different databases — testcontainers cannot reproduce D-109, since a fresh
container has an empty ledger. It refuses to run against a database holding rows,
because its rollback half drops every table.

One exclusion in the catalogue diff, and it is not a loosening: Postgres names
implicit NOT NULL check constraints after the table OID
(`2200_17032_1_not_null`), which differs on every apply. Including them made the
comparison fail on a byte-identical schema — a check that can never pass, which
is worse than one that never fails, because it gets switched off. Nullability is
still compared, in the column rows.

### D-146 · "The notification reached NOBODY" is a log line, not a metric — so no rule watches it
**Status:** Active — an accepted gap, recorded rather than papered over

The dispatcher emits `platform.notify.failed` per CHANNEL and logs the
all-channels-failed case at `error` as `notify.undeliverable` with no counter.
The alert an operator actually wants is the second one.

A rule watching a signal nothing emits can never fire, and a rule that never
fires is indistinguishable from a system that is never unhealthy — the exact
failure this codebase has now found six times. So the shipped rule watches the
signal that EXISTS (`notify.failed`, per channel, threshold 5) and its text says
plainly that it counts channels rather than notifications.

**The fix, when `notify` next changes:** emit a counter alongside the existing
`error` log in `dispatcher.ts`'s undeliverable branch. One line, and then the
rule can be tightened to threshold 1.

### D-147 · The alert evaluator REFUSES TO START without a recipient, and its cooldowns are in memory
**Status:** Active — the D-123 pattern applied to alerting

D-123 made the embedding adapter a boot failure in production without a key
rather than a warning, because "the degraded mode has no symptom". Alerting is
the extreme case: an evaluator with no on-call recipient runs perfectly,
evaluates every rule correctly, delivers to nobody, and is indistinguishable from
a system that is never unhealthy. So: no `--on-call-user-id` and
`--on-call-email`, no start.

`--mail=console` writes page-severity alerts to stdout. That is a real path for a
single-operator deployment reading `docker compose logs`, and it warns loudly on
every start that it is not a pager. `--mail=resend` THROWS until the Resend
adapter exists (build step 14) rather than falling back to console: a deployment
that asked for a pager and silently received a log line would believe it had one.

Configuration is ARGUMENTS, not environment variables, because `process.env` is
read in exactly one place (`platform/config`) and that is lint-enforced. Adding
operational variables there would make the API refuse to boot when an ALERTING
variable is missing — coupling the product's availability to its monitoring,
which is backwards.

Cooldowns are IN MEMORY. The alternatives are a table (a migration, for state
worthless after a restart) or the cache — a dependency whose failure is itself
one of the things being alerted on, so an alerter that goes quiet when the cache
dies is the exact failure §5 is about. The cost is that a restart re-pages
anything still breached; that is the right direction to fail.

Delivery goes through the existing `notify-channel` port and NOT a second
notification path. Severity is expressed as the message KIND (`ops.alert.page`
to email + in-app, `ops.alert.ticket` to in-app only), so "what wakes a human" is
a four-line diff a reviewer can see.

### D-148 · An ABSENT signal never fires a rule, and is never read as zero
**Status:** Active

Every collector is individually failure-isolated and contributes NO KEY on
failure rather than a zero.

Zeroing would be catastrophic in the ordinary way: "the database is unreachable,
so I counted zero breaker transitions" is reassuring news produced by the exact
fault it is meant to detect. Unmeasurable signals are logged at `error` — a blind
spot in the alerter is itself an incident, because every rule on that signal is
now silently disabled — and there is a unit test asserting that an `lte` rule
which WOULD fire on a present zero does NOT fire on an absent signal.

### D-149 · The restore drill compares against counts RECORDED AT BACKUP TIME, and refuses to pass on all-zeros
**Status:** Active — and the drill was proven able to FAIL before being trusted

`full-backup.sh` writes `rowcounts.txt` and `DATABASE` beside each base backup.
The drill restores into a scratch instance and compares. Without a recorded
expectation a drill can only compare against the live database, which is not
always available during a real recovery and which passes silently when BOTH sides
are empty.

Two defects were found by running it rather than by reading it:

1. **The drill connected to the restored cluster's DEFAULT database**
   (`postgres`), where none of the tables exist. Every "this table did not exist"
   expectation matched trivially and ten of thirteen rows reported `ok` — a drill
   passing on a database it had never looked at. Hence the `DATABASE` file: the
   database name is READ FROM THE BACKUP, never assumed.
2. **The self-test's seed silently did nothing.** `docker exec` without `-i` does
   not attach stdin, so psql read an empty script and exited 0. The backup was of
   an empty database. The vacuity guard — "every expected count was zero, so this
   drill would pass against an empty backup and therefore proves nothing" — is
   what caught it.

`drill-selftest.sh` runs the drill twice against a scratch stack: once on a
known-good backup (must PASS) and once with the recorded expectation tampered
with (must FAIL). Both were executed. A drill that always passes is worse than no
drill, because it is believed at the moment it matters most.

**Honestly stated limitation:** the expectation is recorded at backup time, so it
can never contain rows written afterwards. The drill verifies "the backup
restores to the state it recorded". Recovering PAST the base backup to an
arbitrary instant is a different assertion — `restore.sh --target-time` — and
`restore.sh` now prints how many WAL segments it fetched from the archive so the
two cannot be confused. A base backup taken with `--wal-method=stream` carries
enough WAL to recover and promote WITHOUT ever calling `restore_command`, which
is a valid restore and is NOT point-in-time recovery.

### D-160 · `archive_mode = off` is FORCED into every restored instance
**Status:** Active — the most dangerous default in the restore procedure

A restored instance inherits the source's archive settings. Left alone it begins
writing its own divergent timeline into the production WAL archive directory,
which corrupts the chain every other backup depends on — turning a recovery into
a second, worse incident.

`restore.sh` appends `archive_mode = off` to `postgresql.auto.conf` (last
occurrence wins), mounts the backup volume `:ro`, and REFUSES a target volume
named `foxxy_prod_postgres_data` or `foxxy_postgres_data`. Three independent
guards, because a restore script is run by a frightened person at 3am.

### D-161 · The secret scanner is self-testing, and its allow-list is the one uncomfortable place
**Status:** Active — closes D-096's "worth an automated check"

`tools/scan-secrets.mjs` scans TRACKED files only (`git ls-files`), because the
thing that matters is whether a secret is in the repository — a real `.env` on a
developer's disk is gitignored and reporting it would teach everyone to ignore
the check.

Two surfaces, deliberately split: every tracked `.env*` line by line (a `.env*`
exists to hold credentials, so a non-placeholder value in a tracked one is a
finding), and a small set of UNAMBIGUOUS provider token shapes repository-wide
(`sk-…`, `rzp_live_…`, `AKIA…`, `re_…`, a three-part JWT). A scanner that flags
anything high-entropy across a whole repository produces a wall of findings on
hashes, UUIDs and minified assets, and a check nobody can keep green is a check
somebody deletes.

`--self-test` drives every rule against fixtures that must be flagged and
fixtures that must not, through THE SAME function the real scan uses — a
self-test against a re-implementation would prove the re-implementation works. It
exits 2 if any rule has stopped matching, because a scanner whose regular
expressions no longer match anything reports "clean", which is the same output as
a clean repository.

**Proven, not assumed:** the exact D-096 string was inserted into the exact file
D-096 happened in (`backend/.env.example`); the scanner exited 1 and named the
host. The file was then restored byte-for-byte.

### D-162 · A check that matched NOTHING is not a passing check
**Status:** Active — found while proving the gates, not by reading them

The CI step "every shell script parses" iterates `git ls-files '*.sh'`. Run
locally before the scripts were staged, it iterated zero files, never executed
the loop body, and reported a PASS on a script with a deliberate syntax error.

That is the "ESLint rule matching zero files" defect (D-005) wearing a shell
loop. The step now counts what it checked and FAILS on zero.

A second finding from the same exercise, worth recording because it invalidates
the obvious test: `bash -n` ACCEPTS `if [ "$x" = 1 ; then … fi`. `[` is an
ordinary command, so a missing `]` is a RUNTIME failure, not a parse error. The
first attempt at proving this gate was itself measuring nothing.

---

## foxy module — 10 August 2026

Build step 10. Migration `0005_foxy`, `src/modules/foxy/`, and `platform/llm`'s
fake plus real adapters. D-163..D-172.

### D-163 · Foxy is a GUIDED INTERFACE, and the fixed action set is what makes it evaluable
**Status:** Active — the shape of the whole module

Three modes (`doubt`, `explain`, `practice`) and six actions (`simpler`,
`visual`, `example`, `hindi`, `quiz_me`, `confused`). Both are closed sets in
`shared/constants/foxy.ts`, and both are consumed as `Record<Mode, Spec>` and
`Record<Action, Spec>` — TOTAL, so adding a value without a label, an
instruction, a token budget and a translation is a compile error rather than a
value that silently inherits a default.

**The argument is not aesthetic.** A fixed action set means a BOUNDED number of
prompt shapes, each reviewable once and testable forever — which is the only
reason "is the tutor safe" is a question anybody can answer. With open chat it
becomes a question about whatever a child happened to type, and the answer is a
moderation budget and an incident channel.

`hindi` is an ACTION rather than a setting. A student who wants one explanation
in Hindi is not changing their account language, and sending them to a settings
screen in the middle of a doubt is friction that ends the session. It overrides
the session language for exactly one turn.

The capability list is SERVED (`GET /foxy/capabilities`) rather than hardcoded in
the client, so the vocabulary has one definition. A client with its own copy
eventually renders a button the server does not implement, and that fails at the
moment a child presses it.

### D-164 · Citations are verified INCREMENTALLY, mid-stream, not after the answer
**Status:** Active — this is the difference between a citation and a decoration

Plan §8.5: "a language model will happily invent a page number." The model marks
claims as `[chunk:<id>]`; the id is checked against the set of chunks retrieved
FOR THAT TURN; an unknown id is dropped and recorded as fabricated.

**The non-obvious half is WHEN.** The answer is streamed. Verifying at the end
means a fabricated marker has already been shown to the student, so "stripped
before the response is sent" would be false in the one place it is load-bearing.
`domain/citations.ts` is therefore an incremental filter: it withholds any
trailing text that could still become a marker, emits everything else
immediately, and resolves each marker the moment it closes. The cost is a few
characters of latency at a `[`.

**Two decisions inside it that are not obvious and are both tested.**

- THE ID, NOT AN INDEX. `[chunk:1]` is easier for a model to produce and makes
  verification worthless: with three passages, a model that invents an index is
  right by accident a third of the time. A fabricated UUID is fabricated with
  certainty, so the check has no lucky path.
- AN UNTERMINATED MARKER IS RELEASED AS PROSE, and there is a length bound
  (`MAX_CITATION_ID_CHARS = 80`). Without the bound, one stray `[chunk:` swallows
  the rest of the answer — the response stops mid-sentence, forever, with no
  error anywhere, which is the worst failure shape there is.

### D-165 · Abstention is a SUCCESSFUL answer, and the model is never called on that path
**Status:** Active — the product, stated as control flow

An abstention arrives on a 200, as an `abstention` SSE frame (never an `error`
frame), is stored as an ordinary assistant message with `abstained = true`, and
gets its own trace row. The client renders it as an answer with no retry button,
because retrying cannot change the textbook.

`retrieval.search` decides, and the branch that returns the abstention sits above
every line that touches `deps.llm`. A test asserts the scripted model recorded
ZERO calls. **If that assertion is ever weakened, foxy has become a chatbot with
a search box attached.**

The wording is FIXED and bilingual, not generated — asking a model to explain
that it cannot answer is a model call we just decided not to make, and produces a
sentence that varies. Every abstention ends with a NEXT STEP: "I do not know" is
honest and useless.

A CHECK in migration `0005` enforces that an abstention carries no citations. "I
could not find this in your textbook" with a page reference attached is a
contradiction, and it is exactly the row a half-finished refactor writes —
retrieval abstains, the citation extractor runs anyway.

### D-166 · The safety classifier runs BEFORE the model, and its false-POSITIVE rate is the thing to tune
**Status:** Active

A classifier on the model's OUTPUT is a filter; one on the INPUT is a boundary.
Three reasons, and the third decided it: input that will not be answered costs
nothing if it never reaches the model; a refusal composed by us reads the same
every time; and **a child asking about self-harm must be answered by a fixed
sentence naming a trusted adult and a real free helpline (Tele-MANAS, 14416,
reachable from any Indian number) — never by a language model improvising under a
tutoring persona.**

It is deliberately blunt — keyword and pattern matching, not a model — because
grounding catches everything subtle: an off-syllabus question retrieves nothing
and abstains. So it is tuned for the cases abstention CANNOT catch (harm, adult
content, contact-swapping) and is reluctant elsewhere.

**The false-positive half is the part with a test list.** `\bkill (?:myself|me)\b`
rather than `kill`, because half of biology is about things dying; "explain the
reproductive system in humans" is CBSE syllabus and must be answered. A table of
ten such inputs is pinned as ALLOWED.

A refused turn does NOT consume the student's daily allowance. Charging a child a
message for being told to talk to an adult is indefensible. An abstention DOES
consume one — it cost a retrieval, and a free abstention is an unlimited supply
of retrievals.

### D-167 · `sendMessage` returns a PROMISE OF A STREAM, so every status code happens before the first byte
**Status:** Active — the reason a mid-stream failure is never a 500

Authorisation, the usage limit and the session lookup have real HTTP answers:
403, 404, 429. Once a single SSE byte is written the status is committed to 200
and there is nothing left to change.

So the service resolves a promise ONLY once the turn is authorised, admitted and
grounded. Everything before that rejects and the error plugin renders it as
ordinary JSON. Everything after it is a FRAME: a model failure becomes `error`
then `done`, and the tokens already delivered stand. The `error` frame carries
`partial`, because §7 of the frontend plan lists "failed before any token" and
"failed halfway" as two DIFFERENT required client behaviours and nothing else on
the wire distinguishes them.

**The message and the trace are persisted even when the stream fails.** A half
answer the student was shown has to be in the transcript, or the conversation
they remember and the one we stored disagree — and the trace is exactly what
somebody wants when they ask why it stopped.

### D-168 · `chat_messages.seq` is the transcript order; `created_at` cannot be
**Status:** Active — a real ordering bug, surfaced by a fixed clock

A student's question and Foxy's reply can share a millisecond: ALWAYS under the
`FixedClock` every test uses, and intermittently in production. Ordering a
transcript by `created_at` alone then returns the two turns in whatever order the
plan produced — so the transcript reads "assistant, user" at random and the
history handed to the model is incoherent.

This surfaced as four failing assertions that looked unrelated to each other. It
is not a test artefact: a fixed clock makes the bug deterministic and a real
clock makes it intermittent, which is the worse of the two.

`seq bigserial` is monotonic per insert and needs no read-then-write, so two
concurrent turns cannot be handed the same number. The session index is on
`(session_id, seq)`, and every ordering in the repository uses it.

### D-169 · No identity reaches the model, enforced on the ASSEMBLED prompt and not on its inputs
**Status:** Active — 00-ARCHITECTURE.md §0 as a function

`assertNoIdentity` refuses an email address, a phone number and a UUID, and it
runs on every section of the assembled system prompt — because the failure it
guards against is somebody adding a field to a TEMPLATE, not somebody
deliberately passing a name.

Three consequences worth stating:

- **FOXY DOES NOT KNOW THE STUDENT'S NAME and cannot greet them by it.** That is
  the cost of the rule, paid deliberately.
- THE UUID CHECK RUNS BEFORE THE PHONE CHECK. A UUID is digits and hyphens, so it
  matches the phone pattern too, and reporting an account identifier as a "phone
  number" would send the investigation after the wrong bug.
- THE PASSAGE BLOCK IS CHECKED FIELD BY FIELD, not as a rendered string. The
  chunk id is a UUID and belongs in the passage header — the citation scheme
  depends on it — so checking the rendered block would refuse every prompt this
  system will ever build. The chunk TEXT and TITLE still get the email and phone
  checks, and that is not theoretical: NCERT front matter carries publisher
  contact details.

The error carries the KIND and never the offending text. A log line containing
the address it just refused to send is the same leak by a different route.

### D-170 · The language-model adapter follows the `embed` pattern exactly, including the boot failure
**Status:** Active — mirrors D-123

`platform/llm` now has all three pieces plan §5 asks for: the port, a
DETERMINISTIC scripted fake, and a real adapter (the Anthropic Messages API, with
`LLM_MODEL` and `LLM_BASE_URL` overridable so the vendor stays a config value).

**No test calls the real adapter.** There is no key. Every branch — success,
non-2xx, malformed body, empty completion, a frame split across chunk
boundaries, a mid-stream error event, a missing body — is driven by a fake
`HttpClient` and an injected `fetch`. `createContainer` REFUSES TO BOOT in
production without `LLM_API_KEY`, exactly as it does for `VOYAGE_API_KEY` and for
the same reason: the degraded mode is not "slower", it is "every student receives
the same scripted sentence, streamed and cited, through a UI that reports itself
healthy".

Two deliberate asymmetries with `embed`:

- `complete()` does NOT set `idempotent: true`. `platform/http` refuses to retry
  a POST, which is right here — a completion costs money per call, so repeating
  one is a charge rather than a free retry.
- `stream()` bypasses `HttpClient` and takes `fetch` directly, because streaming
  needs the response body AS A STREAM and the client buffers by design.
  `createGuardedLlm` still supplies the first-token timeout, the total budget,
  the breaker and the concurrency slot, so nothing is unprotected — the only
  thing skipped is the buffering, which is the thing streaming exists to avoid.

The SSE reader BUFFERS ACROSS CHUNK BOUNDARIES. A network chunk can split a frame
mid-field; a parser that assumes whole frames per chunk works perfectly in
development and corrupts under real conditions. That is the same hazard
02-FRONTEND-IMPLEMENTATION-PLAN.md §7 warns the CLIENT about — the server has it
too, and it is the same bug.

### D-171 · Applying `0005_foxy` turns the parent transcript on, and the column names are a contract
**Status:** Active

`parent.repository.readTranscript` has probed `to_regclass('public.chat_sessions')`
since build step 12, returning `source: 'not_yet_available'` while the table was
absent. The moment `0005` lands, the probe returns true and the endpoint serves
real rows.

So `chat_sessions(id, mode, started_at, last_message_at, student_user_id,
tenant_id)` and `chat_messages(id, session_id, role, content, created_at)` with
`role in ('user','assistant')` were written against plan §4 BEFORE the tables
existed, and are a CONTRACT rather than a preference. Renaming any of them breaks
a surface where the failure is invisible: an empty transcript reads as a quiet
child.

Two `parent` assertions flipped with this migration and were updated IN PLACE
rather than deleted — `source` from `'not_yet_available'` to `'foxy'`, and the
audit metadata's `available` from `false` to `true`. Both still distinguish "no
conversations" from "the feature has not shipped", which is the property that
mattered; what changed is which side of it is now true.

### D-172 · Three foxy authorisation mutations, all observable — the guard is load-bearing
**Status:** Active — the sixth application of the D-125 method

Each guard was deliberately broken and the suite re-run:

| Mutation | Caught? |
|---|---|
| actor-scoped tenant echoed off the actor (`listSessions`, `getUsage`, `startSession`) | YES — the correct wiring denies, the broken one succeeds |
| session tenant echoed off the actor instead of read from the ROW | YES — a conversation became readable from another tenant |
| conversation OWNER echoed off the actor instead of read from the row | YES — any student could read and send into any conversation |

**No unenforced guard was found**, and that sentence is only worth anything
because all three mutations were installed and observed rather than reasoned
about. They are institutionalised in `foxy.authz-mutation.test.ts`, alongside a
same-tenant, same-owner control so that no "broken wiring" case can be passing
because the service refuses everything.

The actor-scoped mutation is the D-125 case exactly: for `listSessions`,
`getUsage` and `startSession` the resource is the caller themselves, so the
OWNERSHIP rule is trivially true and the tenant comparison is the ONLY thing the
guard does. That is precisely the shape that lost its entire boundary in `parent`
and was found by nothing else.

One honest note on defence in depth: the repository ALSO scopes its queries by
tenant, so the broken `listSessions` returns an empty list rather than another
tenant's rows. The mutation is still observable — the correct wiring THROWS and
the broken one does not — but that second layer is why the assertion is about the
deny path rather than about the payload. Mutations 2 and 3 have no second layer
and leak real rows when broken.

Mutations 2 and 3 are installed through the REPOSITORY rather than by editing the
service: the value the service reads is the value the repository hands it, so a
repository that lies about the row is exactly equivalent to a service that
ignores it, and it needs no source edit to arrange.

---

## Composition-root integration — 10 August 2026

> Four modules were built in parallel against an `app/routes.ts` and
> `app/container.ts` that only one of them was allowed to edit. This section
> records what landing the other three changed, and the one live defect found
> and fixed while doing it. D-173 to D-177 continue from D-172.

### D-173 · `0004_billing`'s journal `when` was below `0003_parent`'s — reproduced, then fixed
**Status:** Closed — the defect was real and is now pinned by a test

`drizzle/migrations/meta/_journal.json` recorded `0004_billing` at
`1786374108357`, below `0003_parent`'s `1786700000000`. This is D-109 exactly,
and the mechanism is worth being precise about, because it is NOT "the
migrations run in the wrong order".

`drizzle-orm`'s migrator does not use `idx` at all. It reads the last row of
`drizzle.__drizzle_migrations`, takes its `created_at`, and applies **only the
journal entries whose `when` is strictly greater than that number.** So on a
database whose ledger had reached `0003`, `0004_billing` failed that filter and
was **skipped in silence** — while `0005_foxy` (deliberately set to
`1786800000000`) passed it and applied on top of the hole.

**This was reproduced before it was fixed, and the reproduction is why the fix
is trustworthy.** A scratch database was primed with a genuine drizzle ledger
through `0003`, then `migrate()` was run against the unfixed journal:

    primed ledger through 0003_parent
    Migrations applied.            <-- the D-109 sentence, applying nothing
    MISSING  subscriptions
    MISSING  payment_events
    ledger rows: 5 -> ...1786700000000, 1786800000000

`subscriptions` and `payment_events` did not exist, `0005` had applied over the
gap, and the exit code was zero. Every command in a deploy pipeline would have
reported success.

**Decision:** `0004_billing`'s `when` becomes `1786750000000` — between `0003`
and `0005`, so the journal is strictly increasing and the `idx` order and the
`when` order finally agree. Nothing else in the file changes and no migration
SQL is touched. Verified by re-running both scenarios (empty database, and a
ledger primed to `0003`) against a scratch database: six ledger rows and both
tables present, in both.

**Why renumber `0004` rather than the alternatives.** Renumbering `0005_foxy`
upward does not help — the problem is `0004` being below `0003`, not `0005`
being above anything. Rewriting the ledger on deployed databases was rejected
outright: nothing has yet been past `0003`, so there is nothing to reconcile,
and a fix requiring a manual step in every environment is a fix that will be
forgotten in one.

### D-174 · The round-trip test could not have caught it, and the reason is structural
**Status:** Active — states the boundary of what the existing migration tests prove

The obvious question is why `migration-round-trip.test.ts` — which applies every
migration, reverses it and re-applies it — was green throughout.

Because **it reaches the migrations through `listMigrations()`, which sorts by
`idx`.** That is the correct order to apply in, and it is why every harness in
the suite uses it. But it means the whole test suite applies migrations by a
mechanism the production migrator does not use, and `when` is never read by
anything under test. The round trip would have stayed green with `0004`'s
timestamp set to any value at all.

That is not a flaw in that test; it is a different question. So the rule is
asserted where it lives — on the FILE — by
`tests/integration/migration-journal-order.test.ts`, which pins four properties
per migration set:

1. there is a subject at all (the guard on the guard);
2. every entry carries a finite positive integer `when` — a missing one is
   coerced rather than rejected, and `undefined > n` is false, so it is skipped
   exactly like an inverted one and just as quietly;
3. `when` increases **strictly** with `idx` — strictly, because two entries
   sharing a `when` are skipped by the same arithmetic as an inverted pair;
4. the migrator's own selection rule, transcribed: for a ledger at any entry N,
   the set of entries with a greater `when` must equal the set with a greater
   `idx`.

**The test was proved to fire** by reverting the value and watching it go red —
naming the inverted pair (`0004_billing` after `0003_parent`) and the migration
that would be skipped — and then restored.

### D-175 · `billing`, `knowledge` and `signals` are wired; three of eleven modules still register no routes
**Status:** Active

`foxy` was wired by the agent that built it. The other three were built while
the composition root was owned by a change in flight and reported their wiring
lines instead. They are now in `buildModules`:

| Module | Pool | Routes |
|---|---|---|
| `billing` | `core` | four, under `/api/v1`, **awaited** |
| `knowledge` | `core`, following `content` | none |
| `signals` | `core`, following `practice` | none |

**The `await` on `billing.registerRoutes` is load-bearing**, and billing is the
only module besides `identity` that needs one. The webhook is registered inside
its own encapsulated Fastify scope because it needs a raw-body content-type
parser: the HMAC is computed over the exact bytes Razorpay sent, and a JSON
parse followed by a re-serialise is not those bytes. `app.register` is
asynchronous, so a dropped `await` lets `app.ready()` win the race — and the
symptom is a webhook that 404s **in production only**, for every genuine
delivery.

**THREE MODULES NOW REGISTER NO ROUTES, AND A COMMENT AT THE FOOT OF
`registerRoutes` SAYS SO.** `retrieval` (D-122), `knowledge` and `signals`.
"Built but never registered" reads exactly like an oversight, and the next
person to notice would helpfully close the apparent gap. Each is a decision: a
`retrieval` or `knowledge` endpoint would let a caller choose the filters —
including a grade the student is not in — and every answer `signals` gives is
about a NAMED STUDENT, in a module with no session and no access guard of its
own. That boundary belongs to the caller that has a request.

`src/app/__tests__/routes.test.ts` pins both halves: driving `registerRoutes`
with `billing` alone produces `/api/v1/webhooks/billing`, and driving it with
each of the other three alone produces an empty route tree.

### D-176 · The `payments` port refuses to boot in production, and it is the worst of the three fallbacks
**Status:** Active

`Container.payments` follows the `embed` and `llm` pattern exactly: Razorpay
when credentials are configured, the deterministic fake otherwise, and a **boot
failure** in production rather than a silent fallback. It is guarded with
`resilience.guard('payments')`, so no caller can hold a bare adapter.

**The degraded mode is worse than either of the other two.** `embed` on the fake
returns confident wrong answers; `llm` on the fake returns one canned sentence.
`payments` on the fake happily CREATES SUBSCRIPTIONS and happily VERIFIES
WEBHOOKS SIGNED WITH A SECRET WE CHOSE — so entitlements would be granted
against payments that never happened, with no error, no failed request and
nothing in a log. It is discovered by reconciling a bank statement.

Three details that are decisions rather than defaults:

* **The error names WHICH credential is missing**, checked in order. The webhook
  secret is a *different* secret from the API key, issued per endpoint in the
  Razorpay dashboard, and supplying the API secret in its place is the standard
  misconfiguration — whose symptom without a boot gate is checkout working
  perfectly while every genuine delivery fails its signature.
* **`RAZORPAY_PLAN_IDS` is deliberately NOT in the boot check.** An empty map is
  a LOUD failure at checkout time: `createSubscription` refuses a plan code it
  cannot map. Only the silent failure needs a gate.
* **The three credentials are narrowed as ONE value**, so the adapter is built
  from strings the compiler has proved non-null. The tempting `?? ''` per field
  is a credential that parses and then reaches Razorpay, which is the exact
  hazard the config schema's own header calls out.

An explicit `payments` override is allowed through in production: "no key was
set" and "this deployment supplies its own port" are different facts, and the
refusal is about the silent fallback, not about the fake.

### D-177 · `practice` exports its anti-cheat floor; `signals` still has no default
**Status:** Active

`modules/signals` could not be constructed at all: its `AntiCheatEdge` needs
`practice`'s `MIN_AVERAGE_MS_PER_QUESTION` and `validateAttempt`, and
`practice/index.ts` exported neither. Both are now exported, **additively** —
`practice` still owns them, `practice.service.ts` still imports them from
`./domain/anti-cheat` directly, and no check, threshold or ordering changed.

**The property preserved is that there is still NO DEFAULT on the edge (D-131).**
A default would be a second copy of a threshold, and two copies drift silently:
the symptom is a `fast_completion` signal that stops agreeing with the rejection
it is defined relative to — sessions refused as too fast that raise no anomaly,
or anomalies raised for sessions nobody refused. Neither errors and neither is
visible from outside. The compile error stays the enforcement.

The edge built at the composition root **discards the reason** on purpose.
`validateAttempt` returns which of the three checks failed, and that reason
belongs to `practice`: it is written to `practice_sessions.invalid_reason` and
read by a human deciding what to say to a student. `signals` gets the VERDICT
only — giving it the reason would invite it to grow a second opinion about what
the reason means, in a second place, from evidence it did not gather.

---

## Log hygiene and enforcement-rule evasions — 10 August 2026

> One live credential leak and five holes in rules that looked authoritative
> and enforced less than they claimed. D-178 to D-183 continue from D-177.
> **Every rule changed here was verified by writing a file that breaks it,
> confirming lint exits non-zero with the intended message, and deleting it —
> the exercise the README calls for, and the one that found the leak below.**

### D-178 · The session token was written to the logs in plaintext, and redaction could not see it
**Status:** Closed — fixed and pinned by an HTTP-level test

`app/plugins/request-id.ts` bound `url: request.url` into the per-request child
logger and emitted one `info` line per response. For the one endpoint that
carries a credential in its query string, that line was:

```json
{"level":"info","requestId":"…","method":"GET",
 "url":"/api/v1/auth/verify?token=hu06Wi4jXIIzTob9Hy_62bR1ywlxI9E6dpRRdOjhMeg",
 "statusCode":302,"durationMs":22,"msg":"request completed"}
```

**That token grants a session on redemption.** Anyone with read access to the
log stream — which in a container is stdout, collected by default — could
complete somebody else's email verification.

**Why the central redaction did not help, and this is the general lesson.**
`platform/logger/redaction.ts` builds `REDACT_PATHS` from 21 sensitive key
names, including `token`, at three depths. It is comprehensive, configured once,
and asserted against its own list — which is precisely why it read as finished.
But pino redacts by KEY, and here the secret was inside a VALUE: one string,
bound under the key `url`, that pino has no reason to parse. The list could have
been twice as long and still been blind. **A redaction list is a claim about the
shape of your data; this leak was a place where the shape was wrong, not where
the list was short.**

**The fix strips the query string at the binding site** (`stripQueryString`, in
`platform/logger/redaction.ts`, next to the list it complements). A PATH is what
correlation wants — which endpoint was called. A QUERY STRING is where secrets
live. Dropping it removes a field that never carried signal.

**Deliberately NOT a filter on credential-shaped parameter names.** That is the
same allow-list shape as `SENSITIVE_KEYS`, and it fails the first time a
parameter is named `t`, `k` or `code`.

**Why the existing test could not fail.** `identity.security.test.ts`'s "no
credential ever reaches a log line" drives the identity SERVICE directly. With
no HTTP request there is no Fastify hook, no child logger and no `url` binding
at all — the leak lived entirely in the gap between what that test exercised and
what production runs. The new test
(`src/app/__tests__/request-id-url-redaction.test.ts`) goes through
`app.inject`, captures what the REAL pino logger writes (the fake does not
redact; asserting against it would prove a property of the fake), and was
confirmed to FAIL with the one-line fix reverted — three of its four assertions
go red.

### D-179 · The dev mail adapter printed every recipient and every body to stdout
**Status:** Closed — pinned by `platform/mail/__tests__/console-mail.test.ts`

`createConsoleMail` wrote `to: <address>` plus the whole rendered `data` —
title, body, and the verification token inside it. **It is the DEFAULT adapter
at the composition root and no Resend adapter exists**, so this was not a local
debugging convenience: it was the production path for every notification email,
writing PII and credentials to the log stream, having bypassed
`platform/logger` and its redaction entirely.

Invisible to the suite because every harness substitutes `RecordingMail` — the
same structural blindness as D-178. The thing that runs in production is the
thing no test drives.

It now prints the template, the recipient's DOMAIN with the person removed
(`[REDACTED]@example.com`), and the data KEYS with every value dropped. Keys are
kept because a missing template field is the common bug and its name is enough
to see it; values are where the body and the token were. **The cost is real and
accepted: copying a verification link out of the dev console no longer works.**
Read the token from the database, or from `RecordingMail` in a test.

### D-180 · D-075 evaded a THIRD time, by backticks — the fourth recurrence of a `Literal`-shaped guard
**Status:** Closed — three evasion shapes proven to fire

D-075 (no test may hardcode a LIST of migrations) has now been fixed four times.
Its array rule selects `ArrayExpression > Literal`; the chain rule's visitor was
`Literal(node)`. **A `TemplateLiteral` is neither.** This exited 0:

```ts
run(readDownMigration(`0008_tenant_not_null.down.sql`, 'superseded'));
run(readDownMigration(`0007_notify_metrics_jobs.down.sql`, 'superseded'));
```

Backticks are idiomatic and neither prettier nor eslint pushes back on them. Two
further shapes also passed, both of which move the extension out of the string:
`['0009_a','0010_b'].map((s) => ...)` with the `.sql` added in the callback, and
`'0013_e' + EXT`.

**Two changes close all three.** The visitor now reads static `TemplateLiteral`
quasis as well as `Literal` strings, and `.sql` is OPTIONAL in the pattern —
because in the last two shapes the extension is not in the string at all. A bare
`0013_e` is already a complete migration identity; the extension was decoration
the defect had learned to hide behind. The cost of the optional extension is
that a string shaped exactly `0000_lower_snake` now counts even without `.sql`,
and three of those in one file is the thing being banned anyway.

**The recurring lesson is about the guard, not the defect.** Four fixes, three
of them defeated by writing the same list in slightly different syntax, because
each fix pinned the SHAPE the defect happened to have that time. A rule keyed to
one node type has an escape hatch in the language grammar.

Proven: all three shapes report (array-of-backticks, 2 errors; vertical chain,
"names 3 different migrations"; map + concatenation, "names 4"), and the
legitimate case — one prerequisite plus a subject in both directions — still
exits 0.

### D-181 · The database rule's message claimed more than its scope enforced
**Status:** Closed — scope widened, and the gap that remains is written down

`DB_PATTERNS` said "Database access lives in *.repository.ts files only" and was
applied under `src/app/**` and `src/modules/**` — two subtrees out of five.
`src/platform/**`, `src/shared/**` and `src/worker/**` were unpoliced, and three
files import `drizzle-orm` outside a repository today:
`worker/jobs/expired-session-sweeper.ts`, `platform/jobs/postgres-queue.ts`,
`platform/jobs/heartbeat.ts`.

**A rule whose text overstates its reach is worse than a narrow rule**, because
everyone downstream reads the text and believes it — the same failure as the
`../*/!(index)` pattern that matched nothing while looking authoritative.

The scope is now all of `src/**`. The two directories that cannot comply are
exempted **by name, in a block that names the three files and calls itself the
gap**, and the message now states the exemptions instead of denying them. They
are exempted rather than rewritten because rewriting them is a separate change
with its own review. Deleting those two directories from the exemption list is
the follow-up; adding a third is not.

Proven: `drizzle-orm` imported from `platform/logger` and from `shared/` both
report; from `worker/` it does not, which is the documented exemption behaving
as written.

### D-182 · `globalThis.process.env` needs no import, so neither rule could see it
**Status:** Closed — four shapes proven to fire

`no-restricted-imports` never fired because `process` is a global that needs no
import, and `no-restricted-properties` matches the identifier `process`, so
`globalThis.process` — a different member expression naming the same object —
walked past both. Four shapes exited 0:

```ts
globalThis.process.env.DATABASE_URL
globalThis['process'].env.DATABASE_URL
const p = process; p.env.DATABASE_URL
const { env } = process; env.DATABASE_URL
```

Three syntax selectors close them (the last two are the same
`VariableDeclarator`). All four now report.

### D-183 · Dynamic `import()` bypassed every boundary rule at once
**Status:** Closed — proven to fire

`no-restricted-imports` inspects `ImportDeclaration` nodes and nothing else, so

```ts
await import('@/modules/knowledge/knowledge.service');   // exited 0
```

defeated the module public surface, the module escape rule, `ENV_PATTERNS` and
`DB_PATTERNS` **simultaneously** — four rules, one line, no diagnostic.

Banned outright inside `src/**` and `tests/**` rather than filtered by
specifier: a filter would be a SECOND list of restricted paths maintained beside
the first, and two lists drift. There is no legitimate lazy import inside the
server — the graph is constructed once, at boot, by the composition root, and
deferring a module load would only move a wiring failure from startup to
whenever the first request happens to reach it.

`scripts/` is exempted and keeps two deliberate dynamic imports: they defer
`platform/config`'s eager, process-exiting environment read until the script has
decided it needs it.

**A note on `no-restricted-syntax` that cost real time:** the rule REPLACES
across flat-config objects, it does not merge. The tests block previously
declared only the migration patterns, so a syntax rule added elsewhere would
have been silently switched off for every test file — most of the repository.
Each declaration now spreads the shared arrays explicitly.

### D-184 · The system prompt was assembled, tested exhaustively, and never pinned as SENT
**Status:** Closed — mutation-proven

A mutation replaced the request literal at `foxy.service.ts:367-374` with one
that **dropped the system message entirely**, set `temperature: 1.5` (the
legitimate maximum across every mode and action is 0.5) and `maxTokens: 4096`.
**All 170 tests passed.**

`assemblePrompt` is a pure function with 23 tests over it, and every property
that matters — the Foxy persona, the CBSE grade/subject scope, the grounding
rule *"Answer ONLY from the reference passages given below"*, the `[chunk:<id>]`
citation instruction, the age-11-to-18 rails — was asserted on **a value nobody
was obliged to send**. Not one test in `src/modules/foxy/__tests__/` read
`harness.llm.recorder.requests`; every LLM assertion was on `callCount()` alone,
which answers "was the model called" and never "with what".

This matters more than it looks: a separate audit established that the abstain
threshold is currently **unreachable** (`below-threshold` cannot fire, so
`no-candidates` is the only abstention the real pipeline produces). That makes
the grounding rule in the system prompt **the only thing** between a weak
retrieval hit and an ungrounded answer given to a child.

Fixed by making the request the single artefact: `toLlmRequest` in
`domain/prompt.ts` is the only builder, it refuses a missing system message, a
temperature above `FOXY_MAX_TEMPERATURE` (0.5) and a non-positive budget, and
`sendMessage` hands the built request — not the assembled prompt — to
`streamedTurn`. Eight service tests now assert on `recorder.requests`: the
grounding rule and citation instruction are present, the grade and subject are
named, **every retrieved chunk id appears in the request**, the temperature
equals the mode's and is under the ceiling, and the budget equals the per-mode
or per-action figure rather than a constant.

Re-applying the original mutation now fails 9 tests.

### D-185 · The trace re-derived the prompt instead of recording it — a self-consistent lie
**Status:** Closed — mutation-proven

`foxy.service.ts:440-442` built the `retrieval_traces.prompt` column from
`prompt.system` **at persistence time**, rather than from the object handed to
`deps.llm.stream`. Under D-184's mutation the existing trace test at
`foxy.service.test.ts:217` still passed: the forensic record asserted a system
prompt the model had never received.

Migration 0005 calls this column "the only way you will ever debug a bad
answer". A column that describes a request rather than recording one is worse
than a missing column — it is the artefact somebody trusts at 2am while
investigating what a child was told.

`streamedTurn` no longer receives the assembled prompt at all. It receives the
`LlmRequest` and the language, and the trace is `renderSentPrompt(request.messages)`
— the same object, rendered once. **Divergence is now structurally impossible
rather than merely unintended.** Proven by mutating the render to drop the
system message: 2 tests fail.

### D-186 · Two foxy tests that passed under the mutation they were named for
**Status:** Closed — both rewritten, both mutation-proven

**(a) The vacuous usage-limit test.** `foxy.service.test.ts:667-685`, *"blocks
BEFORE retrieval and before the model"*, passed with the usage limit **removed
entirely**. It called `sendMessage(...).catch(() => undefined)` and never
drained `turn.frames` — and `sendMessage` returns a *promise of a stream*, so
the model is only reached on drain. Resolving instead of rejecting therefore
left `callCount` at zero just the same. Vacuous in both directions, under a name
that overclaimed. It now asserts the refusal is a `RATE_LIMIT` error, drains the
stream if one was returned at all, and asserts nothing was persisted. (Its
sibling at `:620-637` did catch the mutation, so the limit itself was never
unpinned.)

**(b) Incremental citation stripping was not pinned above the unit level.**
Replacing the streaming filter with a post-hoc one (buffer the whole answer,
strip once) failed exactly **one** test, and only on an incidental token count.
The reason is `createFakeLlm`: it splits on `' '`, and `[chunk:<uuid>]` contains
no space, so **a marker always arrived whole**. A real model splits markers
mid-token routinely.

`__tests__/char-stream-llm.ts` adds a fake that streams one character at a time
and counts what it has yielded. Two tests: the student's visible text never
contains `[`, `chunk:` or the id at **any** point in the stream and is always a
prefix of the final answer; and the first visible token arrives while the model
is still streaming (`yielded() < total()`), which is the property a post-hoc
filter cannot satisfy and a final-string comparison cannot detect. The post-hoc
mutation now fails both.

### D-187 · The grade/subject filter was pinned only in the direction that finds nothing
**Status:** Closed — mutation-proven in both directions

Removing the retrieval filter was caught only because retrieval then returned
**nothing** — every foxy fixture seeded grade 8 science, which is the test
student's own grade and subject. Nothing proved that a chunk sitting in grade 6,
or in mathematics, is *unreachable*.

Two tests now seed off-limits content deliberately, worded to be a **strong**
lexical match for the query so a missing filter wins on relevance rather than by
luck: a grade-8 student must not receive the grade-6 chunk or the mathematics
chunk, in the trace's `retrieved` list or in the prompt. And where the student's
own grade has no chunk at all while another grade has one that answers the
question word for word, the correct answer is to **abstain** — borrowing it is
the failure.

Proven by widening the injected search to merge grade 6 and mathematics results:
the leakage test fails on the retrieved ids.

### D-207 · `identity` gets the mutation test the other three modules already had
**Status:** Active

`billing`, `foxy` and `parent` each carried a `*.authz-mutation.test.ts`.
`identity` — the module that OWNS the boundary, and the one all three resolve
to — carried none. Replacing the second line of `tenantOfStudent`
(`return repository.findUserTenant(studentUserId)`) with `return actor.tenantId`,
which is the D-091 self-comparison exactly, left **all 344 tests green**. The
thirteen-line comment above that function names the failure mode in as many
words; nothing tested it, because every existing caller passes
`tenantId: TEST_TENANT_ID` on BOTH sides.

`src/modules/identity/__tests__/identity.authz-mutation.test.ts` installs three
breaks deliberately — the tenant echoed off the actor (both directions), the
link status hardcoded to `approved`, and the status cached instead of read per
call — and asserts each is OBSERVABLE. The read side of D-073 is now pinned;
the existing D-073 tests covered the WRITE side only. **5 of its 9 tests go red** 
under the mutation.

### D-208 · `content.authoriseRead` is asserted through the SERVICE, per use-case
**Status:** Active

Replacing the body of `authoriseRead` with a no-op left **50/50 passing**.
`kind: 'content'` carries no tenant (migration 0004 gives the corpus none), so
the ownership half of the guard is vacuous BY DESIGN and the read rule allows
every authenticated actor — nothing an ordinary test does can tell "allowed"
from "not asked".

The live effect is `assertTenantMatch`'s first line: *an actor with no tenant is
not a half-authenticated caller, it is a wiring defect, and it must not be able
to reach anything at all*. Gutted, an actor whose `tenantId` is `''` or
whitespace reaches the entire curriculum.

**Only two of the five methods have an HTTP route.** `getQuestionsForChapter`,
`getHeldOutQuestionsForChapter` and `getChunksByIds` are called module-to-module
by `practice` and `retrieval`; for those three `authoriseRead` is the ONLY
authorisation in the path and no route-level check masks it. Ten assertions now
cover five use-cases x two tenantless shapes, all through the service. **All ten
go red** under the no-op.

Also corrected: `content.service.test.ts`'s "denies a write attempt at the
guard" reaches PAST the service to `harness.container.authz` directly. It
asserts the authz table refuses writes and nothing about whether
`content.service` consults the guard. Its comment claimed otherwise; the comment
now states its real scope.

### D-209 · The delivery plan's channel decision is enforced on the wire, and now observed
**Status:** Active

`notify.service.ts`'s `optOut` subtraction —

```ts
deps.dispatcher.channelsFor(kind).filter((c) => !channels.includes(c))
```

— replaced with `[]` left **139/139 green**. It is the ONLY place a recipient's
opt-out is enforced on the wire: `planDelivery` removes opted-out channels at
send time, the plan rides on the job, and this subtraction is what stops the
dispatcher putting them back from its own policy.

It is unobservable TODAY only because every `KIND_POLICY` row has at most one
remote channel, so "what the plan chose" and "what the dispatcher would choose"
cannot differ. It becomes load-bearing the moment `digest_ready` gains
`'whatsapp'` — the change `domain/kinds.ts` advertises as "ONE ROW EDIT" — at
which point a recipient who opted out of WhatsApp receives WhatsApp.

Two tests now make the halves disagree deliberately (dispatcher
`['whatsapp','email']`, plan `['email']`) and assert `{ whatsapp: 0, email: 1 }`
as separate counts.

**And the test that claimed to prove "adding a channel needs no service change"
asserted a SUM.** `whatsapp.sent.length + email.sent.length > 0`. Tightened to
`{ whatsapp: 1, email: 0 }` it reported `{ whatsapp: 0, email: 1 }`: the new
channel received nothing and the test passed on email alone. It now rehearses
the one-row edit where it actually lands — on the PLAN, by amending the job
payload — and asserts both channels received the real message, counted
separately.

### D-210 · `notify` could not tell Hindi from English
**Status:** Active

`BilingualText` is a PROPERTY NAME, not a language: `{ en: 'x', hi: 'x' }`
type-checks, and `notifications_bilingual_check` only rejects BLANKS. Devanagari
assertions before this change: **5 in `parent`, 0 in `notify`, 0 in
`platform/notify-channel`**. P7's enforcement in the module that sends every
notification in the product rested entirely on a required property.

Two tests added. The first asserts the SCRIPT on the stored columns, read raw
rather than through the service's mapper (a mapper that swapped the columns
would satisfy a round-trip assertion perfectly).

The second kills the surviving mutant. `in-app-channel.ts` writing
`titleHi: message.title.hi || message.title.en` left 139/139 green, because
`hi` is non-empty everywhere and `x || y` with truthy `x` is `x` — a fallback
nobody can observe is indistinguishable from no fallback until it fires. It can
fire: `BilingualText.hi` is typed `string`, so `hi: ''` COMPILES. Today that
reaches the CHECK and is refused loudly at the source; with the fallback the
insert SUCCEEDS and an English string is filed as somebody's Hindi, permanently.
The channel is called directly, because this is the ADAPTER's rule and
`notify.send` is not its only caller.

### D-211 · The database half of digest idempotency is now observed
**Status:** Active

`parent.repository.insertDigest` ends in `ON CONFLICT ... DO NOTHING`, and its
comment makes a specific claim: two concurrent generations — a parent tapping
refresh while the weekly worker runs — both pass the `findDigest` pre-check and
both insert, so "the unique index is the only thing that can settle that".

Changing that clause to `DO UPDATE` left **150/150 green**. Every existing
idempotency test calls `generateDigest` twice IN SEQUENCE, so the
application-level pre-check answers first and the INSERT never runs a second
time — the database half is never reached and therefore never observed.

The new test goes straight to the repository, which is what a concurrent second
caller effectively is, and asserts two things rather than one: `created: false`
(so the loser does not send a second digest email) and THE ROW IS UNCHANGED
(`DO UPDATE` returns a row AND overwrites a digest a parent may already have
read, with a different summary and a different `generatedAt`). A row COUNT alone
would not distinguish them, which is why the assertions are about content.

### D-212 · Two comments that asserted coverage which did not exist
**Status:** Active

**`parent.routes.test.ts`'s oracle test.** Its docstring listed a fifth deny case
as *"another tenant — an approved link across a tenant boundary"*, and called it
"the one that separates this from a formality". The fifth entry was *"a child
linked to somebody ELSE"*, and **no tenant boundary was crossed anywhere in the
file**. Both are legitimate refusals, but they are refused by DIFFERENT rules —
consent and tenancy — and only the consent one was pinned. An audit confirmed
the byte-identical property does hold across all of them with a probe; four were
pinned and the docstring asserted five. A genuine sixth case now exists: an
APPROVED pair whose child row is moved to the second tenant while the parent's
session keeps its own.

**`dispatcher.ts` logged the provider's error verbatim.** The line's own comment
says it never logs the recipient, and it does not — but SMTP rejections embed
the envelope (`550 5.1.1 <parent@example.test>: Recipient address rejected`), and
WhatsApp and push providers echo the number and the token the same way. The
address arrived through the ERROR rather than through the recipient. It was
never caught because the only test on that path uses a fake whose message is the
literal `"email exploded"` — a string that cannot fail the assertion it was
written for.

`safeReason` redacts the WHOLE string when `looksLikePii` fires, rather than the
match: `platform/pii` detects but offers no substring rewriter, and writing one
in `platform/notify-channel` would put a second, subtly different PII pattern in
`platform/` — the drift that module exists to prevent. The channel, the kind and
the metric are still logged, so the failure stays counted and attributable.

### D-188 · Anti-cheat rule 2 judged the answer key, not the student
**Status:** Active

`domain/anti-cheat.ts` said the "not every answer the same index" rule operates
on the CANONICAL option index. `practice.service.ts` builds **one shuffle map
per question** and translates every tap through that question's own map, so the
bored tap-through the rule exists to catch — the same SCREEN POSITION, six times
— produces six different canonical indices. The rule was evaluating the authored
`correct_index` distribution instead of the student's behaviour.

Measured by simulation, 20,000 attempts x 6 four-option questions, production
`Math.random`:

| behaviour | over canonical | over presentation |
|---|---|---|
| same screen position every time | 21/20000 = **0.105%** | 20000/20000 = **100.000%** |
| honest random play | 13/20000 = 0.065% | 16/20000 = 0.080% |

Detection of the targeted behaviour went from ~0 to complete at an unchanged
false-positive cost — the 0.08% is `4/4^6 ≈ 0.098%`, the floor four options and
six questions make unavoidable, and is exactly why the rule is switched off at
three questions where it would be ~6%.

The inverse failure is the half that reached students: a full-marks attempt on a
chapter whose `correct_index` happens to be uniform stores one canonical index
every time and was scored ZERO for it.

`AttemptResponse` now carries `presentationIndex` alongside `selectedIndex`, and
rule 2 reads the former. **D-058 is untouched** — the canonical index is still
the only index persisted; the presentation index is recovered at validation time
from the session's own map and written nowhere. `presentationIndex` is optional
solely because `modules/signals` re-validates rows read back from
`practice_responses`, which store the canonical index alone; when it is absent
the rule is SKIPPED rather than falling back, because a fallback reinstates the
defect for whichever caller forgot the field.

### D-189 · The contract described a server-side time backstop that did not exist
**Status:** Active

`shared/contracts/practice.contract.ts` stated that "the server-side backstop is
that the session's own `started_at` bounds the total". It did not: `startedAt`
appeared only as a column mapping, a response field and a sort key, and rule 1
validated entirely against client-supplied `timeSpentMs`. **Six questions
claiming 12s each passed validation inside a 2-second real session.**

`submitSession` now computes `realElapsedMs = now - session.startedAt` — both
instants from the injected clock — and `validateAttempt` CLAMPS the claimed
total to it before averaging. Clamp rather than compare: a claim SMALLER than
the wall clock is ordinary and honest (a paused tab, a student who walked away)
and must stand; only a claim LARGER than the wall clock is impossible.

Consequence: a frozen `FixedClock` now makes any non-trivial claim `too_fast`,
which is correct. Every honest test spends the time it reports; the ones that
deliberately do not are named so.

### D-190 · Two thresholds that were free to move with the suite green
**Status:** Active

`SAME_ANSWER_MIN_QUESTIONS` moved 3 -> 10 and `MIN_AVERAGE_MS_PER_QUESTION`
moved 3000 -> 300 with **219/219 practice tests passing**. Every test referenced
the constants, which is correct for boundary tests and useless as a pin. The
test named *"ALLOWS exactly 3 identical answers"* was written
`allSame(SAME_ANSWER_MIN_QUESTIONS)` — at 10 it asserted that ten identical
answers are allowed while still reporting itself as the test for three. The time
floor was pinned only incidentally in `app/__tests__/routes.test.ts`, a test
about module WIRING.

Both are now asserted as literals in
`modules/practice/__tests__/anti-cheat.test.ts`, beside the boundary tests
rather than instead of them. A threshold has to be pinned where it is authored.

### D-191 · The write paths of `practice` had no access test at all
**Status:** Active

`startSession`'s `assertCanAccess` could be DELETED with 219/219 green — it is
the one call that creates the session row, and therefore the only place the
`tenant_id` that every later check reads is decided. Making `loadSession`'s
guard conditional on `action === 'read'` also passed, because **every existing
access test was a read**.

Both mutations now fail. Note the layering: `refuses submitSession on another
student's session` survives the second mutation because `learner` guards
`getMastery` independently — the tests that isolate practice's own guard are the
`submitAnswer` cross-student case and the cross-tenant case on both writes, and
the file says so.

### D-192 · The per-question shuffle map was untested, because the harness map is constant
**Status:** Active

`tests/helpers/app-harness.ts` supplies `random: () => 0.5`. It produces a map
that genuinely reorders — which is why the D-058 test works — and it produces
the SAME map for every question in a session. Under it, making `shuffleFor`
return the FIRST question's map for every question passed **219/219**.

That writes a canonical index derived from another question's permutation.
`questions.distractor_misconceptions` is keyed by original index (D-048), so
every misconception resolves to a real code for the wrong distractor —
plausibly, silently, and unrecoverably, because the map that would have
translated it is the one that was not used. The existing D-058 test uses a
SINGLE-QUESTION session and structurally cannot see it.

The practice tests now build a module with a seeded LCG for the multi-question
cases, and assert the precondition — the maps reorder AND differ from one
another — before asserting that each stored index round-trips through its OWN
question's map.

### D-193 · Graph coverage reported `orderable: true` for a grade with zero plannable chapters
**Status:** Active

`getGraphCoverage('8','mathematics')` returned 14/14, ratio **1.0**,
`orderable: true`, `cycle: []`. Every one of those 14 chapters failed
`findLearningPath` with `reason: 'cycle'`.

`computeGraphCoverage` projected **in-scope nodes only**; `findLearningPath`
projects **all corpus nodes**. Grade 8 mathematics has 19 prerequisite edges
pointing back into grade 7 mathematics, whose projection contains a cycle. In
isolation grade 8 is acyclic — so `orderable` was a true statement about a graph
nobody ever walks, and it read as health. This is D-129's own argument recurring
inside the instrument built to detect it.

`orderable` and the new `plannableChapters` are now computed from the CORPUS
projection, one `findLearningPath` per covered chapter — the identical call the
feature makes. Measured before/after on the dev corpus (137 chapters, 176 edges):

| grade | subject | total | withGraph | plannable | orderable before | after |
|---|---|---|---|---|---|---|
| 6 | mathematics | 12 | 10 | 10 | true | true |
| 7 | mathematics | 15 | 15 | 2 | false | false |
| 8 | mathematics | 14 | 14 | **0** | **true** | **false** |
| 9 | mathematics | 13 | 13 | 13 | true | true |
| 10 | mathematics | 15 | 14 | 14 | true | true |
| 6 | science | 12 | 12 | 12 | true | true |
| 7 | science | 13 | 12 | 12 | true | true |
| 8 | science | 13 | 13 | 13 | true | true |
| 9 | science | 14 | 12 | 12 | true | true |
| 10 | science | 16 | 13 | 13 | true | true |

One row changed verdict, and it is the one the instrument existed to catch.
Corpus-wide, **101 of 128** covered chapters are plannable — a 27-chapter gap no
field on the old report expressed.

The old scoped reading survives as `orderableWithinScope`, a subordinate
DIAGNOSTIC: the disagreement between the two is the diagnosis, separating "this
grade contradicts itself" (grade 7 mathematics) from "this grade is internally
fine and its out-of-grade prerequisite is not" (grade 8 mathematics). It is
documented as never being the answer to "can this grade be planned".

---

## Retrieval quality and the abstention threshold — 10 August 2026

> **ID COLLISION NOTE.** `D-178`, `D-179` and `D-180` each appear more than once in this file already, from parallel workstreams appending on the same day. The four entries below take `D-201`..`D-204` (D-193 was the highest in use at the time of writing); if another stream claimed them concurrently, renumber THESE rather than the others — they are the newest and nothing references them yet.

### D-201 · The sparse half ANDed every query term, and abstained on 44% of questions the corpus answers
**Status:** Active — fixed in `src/modules/retrieval/retrieval.repository.ts`

`websearch_to_tsquery` conjoins every non-stopword. Measured:

```
"what did mendel find out from his experiments on pea plants"
  -> 'mendel' & 'find' & 'experi' & 'pea' & 'plant'
  chunks matching 'mendel'                :  6
  chunks matching 'mendel | pea | plants' : 89
  chunks matching the full AND query      :  0   -> the sparse half returns nothing
```

…while the corpus contains, verbatim: *"Mendel used a number of contrasting visible characters of garden peas – round/wrinkled seeds, tall…"*.

Across the 54-question in-corpus golden set (`npm run eval:retrieval:recall`, dev corpus, candidate limit 50):

| | zero candidates | mean candidates |
|---|---|---|
| BEFORE — AND semantics | **24 of 54 (44.4%)** | 3.87 |
| AFTER — OR + `ts_rank_cd` | **0 of 54 (0.0%)** | 49.19 |

**Decision: OR semantics, with the RANKING doing the discrimination.** The lexemes are taken from `to_tsvector(config, query)` — the same parser and dictionary that built `rag_chunks.search_vector`, so query and index tokenise identically by construction — quoted by Postgres's own `quote_literal`, joined with `|`, and cast. A query that reduces to no lexemes yields `null` and matches nothing, as before.

**The property deliberately preserved:** `websearch_to_tsquery` was chosen over `to_tsquery` because `to_tsquery` RAISES on ordinary prose ("what is refraction?" is a syntax error a student would see as a failed answer). Nothing in the new query can raise on user input either — the only cast is applied to an aggregate of Postgres-quoted lexemes. Verified against empty input, stopword-only input, Devanagari under the `simple` configuration, and `"quoted phrase" -excluded term & | ! ( )`.

**What is deliberately lost:** websearch's negation. `-term` becomes an ordinary OR term. Ranked last among the lexemes it barely moves the order, and the alternative is a second, fragile tokeniser in TypeScript for a syntax a student typing into a chat box does not use.

**What OR costs, stated:** the sparse list is now nearly always full. Extra recall at the bottom of a 50-list is close to free — RRF reads only rank, and rank 50 of one list contributes 1/110 — but it means the sparse half no longer discriminates by ITSELF. That job moved to the ranking (D-202) and to the measured threshold (D-203). A graded AND-then-OR fallback was considered and rejected: it is a second query path in the one module whose header says there is exactly one, and measurement showed the ranking alone puts the right passage higher (see D-202's probe 3, where an AND-first prior demoted the actual proof from rank 5 to rank 8).

### D-202 · `ts_rank` saturates at exactly 1.0, so the top of every sparse list was ordered by random UUID
**Status:** Active — fixed in the same file

`ts_rank` returns `float4`. For any well-matched document the value pins to exactly 1.0. Measured on *"what is refraction of light"*, grade 10 science: **twelve chunks tied at exactly 1.0**, so the top twelve were ordered entirely by the `id asc` tiebreak — that is, by random UUID — and the chunk that states the laws of refraction sat at **rank 14** with `0.9999998`, below any cut.

**Decision: `ts_rank_cd(search_vector, tsq, 1 | 32)`.** Cover density rather than a saturating sum, with two normalisation bits, both load-bearing:

- **`1`** — divide by `1 + log(document length)`. Without it a long chunk repeating one lexeme outranks a short one that answers the question. Probe 3 below is the case that chose it.
- **`32`** — divide by `rank + 1`, bounding into [0, 1).

Measured on three probes, rank of the passage that actually answers the question, and distinct scores in the top 12:

| probe (grade/subject) | before: `ts_rank`, AND | after: `ts_rank_cd(33)`, OR |
|---|---|---|
| "what is refraction of light" (10/science) | rank **14**, 4 distinct scores in top 12 (12 tied at 1.0) | rank **2**, **12 distinct** |
| "what did mendel find out from his experiments on pea plants" (10/science) | **0 rows — abstained** | rank **1**, **12 distinct** |
| "prove that root 2 is an irrational number" (9/mathematics) | 3 rows, none the proof | rank **5**, **12 distinct** |

Normalisation flags 0, 2, 4 and 32 alone were each measured on the same three probes and each ranked at least one target worse; `1 | 32` was the only setting with no ties in any top 12.

**This is not a cosmetic change bundled in with D-201 — it is what makes D-201 safe.** With a saturating rank an OR query is fifty rows in arbitrary order.

### D-203 · The abstention threshold was unreachable by construction; it is now MEASURED
**Status:** Active — supersedes the `UNCALIBRATED` constant

`ABSTAIN_THRESHOLD.value` was `minFusedScore(50, 60)` = 1/110, compared with a strict `<`. The worst score a document can achieve is **exactly** 1/110. So `below-threshold` could never fire; the only abstention the pipeline could produce was `no-candidates`. The unit test that claimed to pin this asserted `value === minFusedScore(CANDIDATE_LIMIT, RRF_K)` — the expression the constant was defined by, a tautology that would have held for any value.

**Calibrated 10 August 2026** — 54 in-corpus + 20 off-syllabus questions, scored end to end through the shipped service, voyage-3 at 1024 dimensions, 4,403 active chunks, candidate depth 50, RRF k = 60:

| fused top score | n | min | p5 | median | p95 | max |
|---|---|---|---|---|---|---|
| in-corpus | 54 | 0.028850 | **0.029877** | 0.032018 | 0.032787 | 0.032787 |
| off-syllabus | 20 | 0.024448 | 0.024448 | 0.030622 | **0.032522** | 0.032522 |

In-corpus questions returning no candidates: **0 of 54**.

**The distributions overlap** (`separated: false` — in-corpus p5 sits below off-syllabus p95), so the placement RULE is the policy, and the two available rules disagree by a factor of six in what they cost:

| rule | value | off-syllabus refused | **in-corpus wrongly refused** |
|---|---|---|---|
| 5/95 midpoint (the shipped `suggestThreshold`) | 0.031200 | 55.0% | **24.1%** |
| in-corpus false-abstain budget, 5% (**ADOPTED**) | **0.029877** | 35.0% | **3.7%** |

**Decision: the budgeted rule.** `domain/calibration.ts`'s own header argues the asymmetry — a false abstention is a student told "I do not know" about material the corpus covers; a false acceptance is a weak passage Foxy's grounding and citation verification already has to survive. The midpoint encodes no such weighting, and 24.1% is not a price that argument permits. `suggestThresholdWithinFalseAbstainBudget` was added alongside `suggestThreshold` rather than replacing it, and the harness prints BOTH with both error rates, so the trade is visible rather than implied. The chosen rule is recorded in the provenance (`policy`, `falseAbstainBudget`).

**What this threshold is NOT: a relevance detector.** The overlap is structural. Both halves return 50 rows for any input a student can type, so the fused top score is dominated by whether ANY document is ranked highly by both — a question about the Krebs cycle asked of grade 10 science still produces agreement between two retrievers about which wrong chunk is least wrong. **Off-syllabus rejection is shared: this catches ~35% of it and `foxy`'s grounding owns the rest.** Anyone raising the number to improve that share should read the 24.1% first. *(Open question, for assessment: whether the trace should carry the dense half's raw top cosine distance as a second, independent signal. It is a genuine relevance measure and is already computed; putting it on the fused scale is not possible, so it would be a new decision, not a tweak.)*

**Context — what the same measurement would have produced the day before.** With the AND-semantics sparse half, 20 of 20 off-syllabus and 24 of 54 in-corpus questions returned no sparse rows at all; a dense-only turn scores exactly 1/(60+1) = 0.016393, so both distributions would have been pinned to that value at both facing percentiles. Any rule places the line at 0.016393, and a threshold equal to the only score present abstains on nothing. **The floor would have measured as fully inert while looking calibrated.** Fixing the retriever is what made a threshold measurable at all — which is the argument for doing D-201 and D-202 before this entry, not after.

**Two coupled defects fixed with it, both of which made the guard decorative:**

1. **`assertThresholdOnFusedScale` was never called on the threshold the service uses.** `retrieval.service.ts` read `deps.threshold ?? ABSTAIN_THRESHOLD`; the shipped constant had a unit test, the OVERRIDE — the supported path, the one the eval harness and every future caller takes — had nothing. `{ value: 0.7 }` is a sensible cosine floor, an unreachable fused one, and would have abstained on every query while the trace reported the threshold without complaint. **The exact historical defect, reproducible through the parameter provided to avoid a second code path.** Both guards now run in the service constructor, before any query can be issued; a bad value is a process that does not start.
2. **Inertness was coupled to a constant the service lets you override.** The value was baked from `CANDIDATE_LIMIT = 50` while the service reads `deps.candidateLimit ?? CANDIDATE_LIMIT`. At depth 100 the bottom of the fused scale drops to 1/160 and ranks 51-100 fall below a floor described in its own file as incapable of filtering — silently. **`candidateLimit` is now a required field ON the threshold**, not a constant looked up elsewhere, and `assertThresholdMatchesCandidateDepth` refuses a mismatch at construction. The measured percentiles describe one depth and no other.

**Any change to the retriever invalidates this measurement completely** — the sparse query, the ranking function, `RRF_K`, `CANDIDATE_LIMIT`, or the embedding model. That is a re-run, not an adjustment.

### D-204 · `hnsw.ef_search` was absent on the worker pool, where retrieval also runs
**Status:** Active — fixed in `src/platform/db/pools.ts`

D-049 set `hnsw.ef_search = 100` as a connection parameter on the `ai` pool, and three separate comments described `ai` as "the only pool that gets it". The description was true; the conclusion was wrong. `app/routes.ts` builds retrieval on a different pool in the worker process:

```ts
db: forWorker ? container.pools.worker : container.poolFor('retrieval')
```

So the worker's vector query ran on connections where the parameter had never been set, pgvector applied its default of 40, and `limit 50` returned 40 rows. No error, no log line, no wrong answer — just a top-50 that is quietly a top-40, **in the one process nobody watches a latency graph for**. The symptom is a corpus that reads as slightly thin in background jobs and normal in the API.

**Decision: the setting follows the QUERY, not the pool's name.** `worker` now carries it; `auth` and `core` still do not, because no vector query can reach them and a setting sprayed everywhere stops documenting anything. The worker keeps the ORDINARY statement timeout — adding search breadth must not also hand a background job the 5-second vector ceiling.

**Why this survived: it was covered only by a Docker-gated integration test.** `tests/integration/hnsw-ef-search.test.ts` proves the setting works — it runs a real HNSW scan at 40 and at 100 and watches pgvector cap the row count — and it is the important test. But it needs a container, so on every machine and every lane without one, "is the parameter on the pool retrieval actually runs on?" had no answer. The same was true of the hard grade/subject filter, which is a content-safety property, not a quality one.

**So both got fast-lane coverage, and the shape of it is the reusable part:**
- `src/platform/db/__tests__/pools-startup-options.test.ts` constructs the pools — `pg.Pool` connects to nothing until a client is checked out — and asserts the startup options for every pool retrieval can be handed.
- `src/modules/retrieval/__tests__/retrieval.repository.test.ts` extracts the two queries into pure builders and renders them through drizzle's own `PgDialect`, asserting the `where`, the parameters, the ranking function and the text-search configuration per language.

Neither replaces the integration suite — they cannot tell you the query RUNS. They replace the integration suite being the ONLY copy. Each was verified by re-applying the original defect and watching the new test fail.

### D-205 · The service-test harness states its own abstention floor; production keeps the MEASURED one
**Status:** Active — `tests/helpers/app-harness.ts`, pinned by `src/app/__tests__/wiring.test.ts`

D-203 replaced an inert floor with a real one measured against **real voyage-3 query embeddings**. `tests/helpers/app-harness.ts` mirrors the production wiring on purpose, so it inherited that floor — while embedding with `createDeterministicEmbed`, whose vectors are reproducible hashes of the input text and **carry no semantics whatsoever**.

**A meaningless vector produces a meaningless fused score, and comparing a meaningless number against a floor measured on meaningful ones is not a test of the floor.** It makes every assertion in every suite built on the harness contingent on the arrangement of a fake.

That is what happened. Exactly one foxy test — `sends the ACTION's budget and temperature when a button produced the turn` — began failing with `the model was never called`. The turn had a perfectly good seeded grade-8 science chunk; the only reason it abstained is that a hash landed a hair below 0.029877. Every neighbouring test in the same describe block passed. **That is the worst version of this failure mode: the suite's colour tracks the fixture strings rather than the behaviour, so it moves when somebody rewords a test's sample question.**

**Decision: the harness declares `HARNESS_ABSTAIN_THRESHOLD` — value 0, "never abstain on score", `UNCALIBRATED` with the reason written into the provenance.** Not a magic number in a wiring call; a named, exported constant whose declaration carries the argument. This is the same position, for the same reason, that `tests/integration/retrieval-search.test.ts` already took for itself — that suite tests the SQL and said so. The divergence from `app/routes.ts` is now the one place in the harness that is deliberate and labelled, rather than an inheritance nobody could see.

**It is not a weakening, because abstention keeps all of its coverage:**
- `no-candidates` — seed no chunks for the grade. **Not a score comparison**, so a zero floor exercises it in full, through the real pipeline.
- `below-threshold` — injected via `AppHarnessOptions.search` / `useSearch`, which returns the abstention directly.
- the safety refusals — upstream of retrieval entirely.
- the decision function — `retrieval/__tests__/abstain-threshold.test.ts`.
- the distributions and the error rates — the golden-set harness in `eval/retrieval/`.

All were re-run and pass. A test that genuinely wants the score-based path now passes `AppHarnessOptions.threshold` and states why, rather than leaning on whatever the default happens to be — **an inherited floor is invisible, a stated one is arguable.**

**The half of this that is NOT a test change: production could now drift the other way and nothing would say so.** Three seams zero this floor for good reasons (the eval sweep, the retrieval integration suite, and now every service suite), and `buildModules` runs the shipped value by *not passing one* — the absence of a line, which no diff draws attention to. That is the shape from which a fourth override reaches the composition root and sits there for a year. It is D-203's failure inverted: not a floor that abstains on everything, a floor that abstains on **nothing** while its provenance still reads `MEASURED`.

So `RetrievalService` now exposes the **resolved** threshold — after `deps.threshold ?? ABSTAIN_THRESHOLD` and after both constructor guards — and `wiring.test.ts` asserts on it: the provenance is `MEASURED`, the value is `0.029877369007803793`, it is strictly greater than zero, and the **background worker's is the same object shape as the API process's** (two construction sites, two places an override could land on one and not the other; Foxy and the worker would then disagree about what "we do not know" means). Read-only and carrying its provenance, so nothing can consume it as a bare number without also being handed the evidence.

**Verified by re-applying the P12 mutation the failing test exists to catch** — dropping `{ role: 'system', … }` from `toLlmRequest`, which deletes the grounding rule, the citation instruction, the grade/subject scope and the age rails from what the model receives. 7 tests fail under it, including the one this entry fixed. **A repair that makes a test green but blunts its mutation is worse than the failure it replaced**, and that is the check that distinguishes the two.

---

## Audit and remediation wave — 10-11 August 2026

### D-213 · Eleven parallel agents collided on this file's numbering
**Status:** Active — a process rule, not a code change
Seven read-only auditors and six fixers ran in parallel. Several appended entries at the same time, each choosing its number from the maximum present when it started. Result: **D-080 and D-178 through D-183 were each claimed twice, by different agents, for different content.** Three agents flagged the risk in their reports; none could avoid it, because the number is chosen at write time and the file is append-only.

Renumbered on 11 August: the second claimant of each became D-206 through D-212. No content was lost or merged.

**Rule going forward:** a monotonically increasing identifier assigned at write time cannot be made collision-safe across concurrent writers. Either the orchestrator assigns ranges before spawning, or entries are keyed by something that does not need coordination — a date plus a slug. **The orchestrator assigning a range per agent is the cheaper fix and is what will be done.**

Note that `D-059`, `D-073` and `D-075` also appear twice, and those are **deliberate**: a later entry marking the original RESOLVED, in place, so the history reads forwards. That pattern stays.

### D-214 · Mutation testing found nine defects that 2,510 passing tests did not
**Status:** Active — this is now the standard for any guard
Eleven agents audited every module by **breaking each guard, validation and threshold in the source and checking whether a test went red.** The suite was fully green before, during and after.

What a green suite did not notice:

| Defect | Detection before |
|---|---|
| Retrieval abstained on 24 of 54 known-good in-corpus questions | none — no test measured recall |
| `ts_rank` saturated at 1.0; top twelve ordered by random UUID | none |
| The abstain threshold was arithmetically unreachable | a **tautological** test comparing the constant to the expression that defined it |
| Foxy's system message could be deleted, temperature set to 1.5, budget quadrupled | 170/170 passed |
| Anti-cheat rule 2 fired on 0.105% of the behaviour it targets | 100% under the harness's constant-random shuffle |
| `timeSpentMs` had no server-side bound despite the contract claiming one | none |
| The session token was logged in plaintext | a test that ran at the service layer, where the HTTP hook never fires |
| Four guards compared a value with itself or could be gutted entirely | none |
| `knowledge` reported a grade as fully covered and orderable while producing zero paths | none — the report and the feature projected different graphs |

**The pattern is now at nine instances**: enforcement that looks installed and enforces nothing. Every single one was found by deliberate breakage, and none by review, coverage, or a passing suite.

**Standing rule:** a guard is not considered enforced until a mutation of it has been shown to turn a named test red. Modules with an `*.authz-mutation.test.ts` file are the pattern to copy — after this wave, `identity`, `content`, `notify`, `parent`, `billing`, `foxy` and `practice` all have one.

### D-215 · Three fixes were made structural rather than test-only
**Status:** Active
Where a defect was a missing assertion, the temptation is to add the assertion. Three fixes deliberately went further, because an assertion protects one call site and a constructor protects all of them.

- **Foxy's request** now has exactly one builder, which **refuses** a blank system message, a temperature above the ceiling, or a non-positive budget. The trace renders from the messages that were sent, so it cannot describe a prompt the model never received.
- **The abstain threshold** carries `candidateLimit` as a required field, and both scale guards run in the service constructor on the resolved value. A depth-100 override is now a boot failure rather than a silent drop of ranks 51-100.
- **The anti-cheat presentation index** is optional and, when absent, the rule is **skipped rather than falling back** to the canonical index. A fallback would silently reinstate the defect for whichever caller forgot.

### D-216 · The calibration policy was chosen against the shipped algorithm
**Status:** **Needs assessment review**
With the Voyage key working, the threshold was calibrated on 54 in-corpus and 20 off-syllabus questions. The distributions **overlap**, so the placement rule is the policy, and the two candidate rules differ by six times:

| rule | value | off-syllabus refused | **in-corpus wrongly refused** |
|---|---|---|---|
| 5/95 midpoint — the shipped `suggestThreshold` | 0.031200 | 55.0% | **24.1%** |
| 5% false-abstain budget — **adopted** | **0.029877** | 35.0% | **3.7%** |

The midpoint was rejected: refusing 24% of answerable questions contradicts the asymmetry the calibration module's own header argues for. The budget rule was added alongside rather than replacing it, and the chosen policy is recorded in the provenance.

**This is a product decision sitting in a constant.** 35% off-syllabus rejection means the threshold is a floor, not a relevance detector — Foxy's grounding instruction owns the rest. Assessment should confirm the 5% budget is the right trade.

---

## Production boot, alerting and destructive-guard wave — 11 August 2026

Range D-249 to D-256, assigned before the agent was spawned (the D-213 rule, applied). Five defects, all of one shape: **a mechanism that was present, correct-looking and enforcing nothing.** Two of them would have stopped production booting at all; two more would have been discovered only by an outage nobody was paged for, or by a customer's failed payment.

### D-249 · The destructive migration guard checked four tables out of thirty-four
**Status:** Fixed — `backend/scripts/ops/migration-round-trip.ts`

`db:round-trip` DROPS EVERY TABLE in `public`. Its only safeguard counted rows in a hardcoded list: `chapters`, `rag_chunks`, `questions`, `users`. Those were the tables that existed and mattered on the day it was written.

The schema has thirty-four. **None of the other thirty was guarded** — `jobs`, `metrics_events`, `notifications`, `subscriptions`, `payment_events`, `audit_log`, `xp_ledger`, `sessions`. A database holding a year of billing rows, or the append-only record of every privileged action, passed the guard cleanly and was then dropped table by table.

This is **D-075 in a new costume**, and the header of `listMigrations()` — nine lines above the guard — already said D-075 had been found four times in this repository, twice inside the code written to prevent it. This was the fifth.

The distinguishing property: **a hardcoded list fails OPEN.** A table nobody added to it is a table the guard is silent about, and silence is indistinguishable from "checked and empty". The list is gone; the catalogue is asked which tables exist and any row anywhere is a refusal. One exclusion, `__drizzle_migrations`, named explicitly rather than matched by a `__%` pattern so a future `__anything` is guarded rather than accidentally exempt.

**Proven by regression, not by reading.** `.github/workflows/backend-ci.yml` now builds a database in exactly the shape the old guard waved through — one row in `audit_log`, all four of the old names EMPTY — and fails if the script accepts it or refuses without naming the table. Reverting the guard to the four-name behaviour locally made that step report `FAIL`, and the reverted guard printed `guard inspected 4 table(s); 0 hold rows` and proceeded to drop.

**A consequence worth stating:** migration 0004 seeds the default tenant, so an *already-migrated* scratch database now trips the guard. That is deliberate. The alternative is a list of rows the guard is willing to ignore, which is the defect again — it cannot tell a seeded tenant from a real one, and the permissive guess is the one that drops the development corpus. The error names the fix (`drop database` / `create database`), which is what CI already does.

### D-250 · Production could not boot, and it would have read as a crash
**Status:** Fixed — `docker/compose.prod.yml`

`compose.prod.yml`'s backend environment block ended at `RESEND_API_KEY`. It passed no Razorpay credentials and no plan ids. `src/app/container.ts` throws in production without all three Razorpay credentials. So `backend-api` and `backend-worker` would have thrown inside `createContainer`, exited, and been restarted forever by `restart: unless-stopped`.

The refusal is correct and stays — the payments fake happily creates subscriptions and happily verifies webhooks signed with a secret we chose. **The problem was never the refusal; it was what the refusal looks like.** Two containers cycling every few seconds reads as a crash, a bad image, or postgres not being ready. The one line naming the variable scrolls past inside a restart storm, in a log stream the restarts themselves are truncating.

Every required credential is now `${VAR:?message}` rather than `${VAR:-}`. That difference is the whole fix: `:-` supplies an empty string, which reaches the container, fails `z.string().min(1)`, and rebuilds the crash loop; `:?` makes **compose itself** refuse, naming the variable, creating nothing. It runs before an image is pulled and cannot be skipped, because interpolation happens on every compose invocation including `deploy-app.sh`'s `up -d --no-deps`.

The trade is deliberate: a `.env.prod` missing a Razorpay key now blocks a *marketing* deploy too, because interpolation is whole-file. A deployment where one of these is unset is a deployment that must not be shipping anything.

**Inverse hazard, recorded because it is easy to reintroduce.** The bare `KEY:` form is load-bearing for every OPTIONAL variable and is *not* the same as `${KEY:-}`: measured with `docker compose config`, `LLM_MODEL: ${LLM_MODEL:-}` SETS an empty string in the container while `LLM_MODEL:` passes it through or omits it. These are `.optional()`, optional means ABSENT, and an empty string is a present value that fails `min(1)` — so `:-` on an optional variable is this same crash loop rebuilt out of its own fix.

### D-251 · The alerting stack could not page anyone, and that was the default
**Status:** Fixed — `backend/scripts/ops/alert-evaluator-main.ts`, `docker/compose.prod.yml`

`--mail` defaulted to `console`. The only other value, `resend`, threw, because no Resend adapter was ever written. **There was exactly one reachable transport and it was stdout.** Every page-severity alert the evaluator has ever raised was written to a container log and read by nobody.

Separately, the `backend-alerts` container had **no backup-volume mount and no `--backup-dir`**, so `producibleSignals()` omitted `backup.age_hours` and the `backup_stale` rule could never fire — "there has never been a backup" reported identically to "backups are fine".

A monitoring stack that cannot page anyone is **worse than none, because it is believed.** "No page came in" was being read as "nothing was wrong", and the two were indistinguishable — the worst property any piece of software can have, and the exact property D-123 made the embedding key a boot failure over.

Three changes:

1. **`smtp` is the default, not `console`.** The old default made the quiet outcome the automatic one. The loud outcome is automatic now: with no SMTP configured the evaluator throws and the container fails to start, so **its absence from `docker compose ps` is itself the signal**. It uses `platform/mail`'s SMTP adapter — the same one signup and password reset use, not a second SMTP client written for ops, because a monitoring path built from different parts can succeed while the product's fails.
2. **`console` remains selectable and still warns on every start.** It is a genuinely real delivery path for one operator watching `docker compose logs`; it is simply not a pager, and choosing it now means typing it into `.env.prod` where a reviewer sees it. `resend` is removed, with an error naming `smtp` rather than "unknown transport".
3. **`backup_data:/backup:ro` is mounted and `--backup-dir=/backup` passed.** Read-only: the evaluator stats mtimes and must never be able to write, rotate or delete a backup whose age it is judging.

A dead `if (backupDir === undefined) logger.warn(...)` was **removed rather than left**: `assertRulesAreSatisfiable` has already thrown by that line, so the branch was unreachable — and a reader finding it would conclude that running without a backup directory is a degraded-but-permitted mode. It is not.

Proven by breaking it four ways: missing SMTP settings, `--mail=resend`, an unknown transport, and a missing `--backup-dir` each refuse to start with a message naming the cause.

### D-252 · The required-variable list was TypeScript, the supplied list was YAML, and nothing related them
**Status:** Fixed — `backend/scripts/ops/env-contract.ts`, `env-contract-check.ts`, `preflight-env.ts`, the `preflight` compose service

D-250 was not carelessness. It is what happens structurally when the list of variables an application REQUIRES lives in `src/` and the list a deployment SUPPLIES lives in a compose file, and no mechanism compares them. Adding the missing lines fixes today. Two mechanisms stop it recurring:

**The CI gate (`npm run ops:env-contract`).** Extracts the production boot refusals from `backend/src` and every variable from `config.schema.ts`, then fails if any is not passed by `compose.prod.yml`, or not documented in `docker/.env.prod.example` and `backend/.env.example`. Variables production deliberately does not pass live in an explicit `NOT_PASSED_BY_DESIGN` allow-list with the reason each schema default is right — the ergonomics are intended to be mildly uncomfortable, because the default answer for a new variable is "compose must pass it" and opting out should mean writing down why.

**The runtime pre-flight (the `preflight` service).** A one-shot container running the same image and the same config parser as the API, depended on by api, worker and alerts through `service_completed_successfully`. It catches what interpolation cannot see, because to compose a value is just a string: present-but-blank, and a malformed `RAZORPAY_PLAN_IDS` (D-253). It reports **every** problem at once rather than the first, so a new deployment is one list instead of five deploys. It performs **no I/O** and declares no `depends_on`, so it can never be the reason a recovery is slow.

Why both, and why the runtime one carries a *cached* list: the authority is `container.ts`, which throws — and the Dockerfile copies `dist/` and `dist-ops/` and deliberately leaves `src/` behind, so nothing in the production image can read it. **A copy that can drift silently is the defect; a copy whose drift fails the build is a cache.** The drift window is one CI run, not one production incident.

Both gates **self-test**, because a check whose pattern has stopped matching reports a pass. Every extraction asserts a plausible minimum on what it found (at least 20 schema variables, 50 source files, 1 boot refusal) and fails loudly otherwise. Two gates in this repository were previously found green while enforcing nothing — an ESLint rule whose `files` pattern matched no file, and `ci.yml`'s shell-syntax loop, which iterated over an empty `git ls-files` and reported success on a script containing a deliberate syntax error.

### D-253 · `RAZORPAY_PLAN_IDS` discarded what it could not parse and returned success
**Status:** FULLY CLOSED by D-272 — the open half ("the parser should refuse rather than shrug") is done; the pre-flight is retained because it also checks the map against `purchasablePlans()`.

`config.schema.ts`'s `parsePlanIds` drops any pair it cannot understand and returns what is left. So `RAZORPAY_PLAN_IDS=monthly=plan_x` — an `=` where a `:` belongs — becomes `{}`: a value the type system is perfectly happy with, that boots, that reports healthy, and that fails at the checkout of the first customer who tries to pay us.

`container.ts` argues, correctly, that the plan map is not one of its boot refusals because an empty map is a **loud** failure — `createSubscription` refuses a code it cannot resolve — whereas missing credentials are a **silent** fallback, and only the silent one needs a boot gate. The gap that reasoning leaves is **who** the failure is loud to. `{}` is loud to a paying customer, in a paid funnel, on a deployment that has reported itself healthy since it started. Moving it to boot costs nothing and changes the audience from a customer to an operator.

The pre-flight now refuses on a malformed pair, an empty entry (a stray or trailing comma), a duplicated plan code (the later pair wins silently, so half the variable is decoration and the value does not show which half), and a purchasable plan with no mapping — **naming the offending entry** in each case. The required codes are **discovered** from `purchasablePlans()`, the same catalogue checkout resolves against, so a third paid plan starts being required on the commit that adds it, with nothing for anyone to remember (D-075, applied rather than evaded).

The raw string reaches the script as a command-line ARGUMENT, because `config` exposes only the parsed map and the parse is precisely what discards the bad pair. A plan id is an identifier, not a credential.

**Open, for the config owner:** `parsePlanIds` still silently drops malformed pairs for every other caller. The pre-flight makes that unreachable in a deployed stack — the container never starts — but the parser should refuse rather than shrug. That change is in `backend/src/` and was not made here.

### D-254 · The SMTP settings were guessed, and one of the guesses was wrong
**Status:** Fixed — `docker/compose.prod.yml`, `docker/.env.prod.example`

While the SMTP adapter was being written in parallel under `src/platform/mail`, compose passed the SMTP variables with **soft `${VAR:-}` defaults on purpose**: marking a *guessed* name required would restart-loop production on a variable that does not exist, which is D-250 rebuilt from the other direction.

The adapter landed. The names are settled (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`), `container.ts` grew its own refusal for them, and all four required ones are now `${VAR:?}`. One guess had been wrong — see D-255.

`SMTP_PORT` is deliberately **not** required: it has a schema default of 587, the adapter derives `secure` from the port (465 is implicit TLS, everything else STARTTLS), and there is no third setting to get wrong. `SMTP_FROM` is a separate variable from `SMTP_USER` because Workspace allows sending as an alias, and the envelope sender and the visible From are not the same thing to a receiving spam filter.

The four are also in `PRODUCTION_REQUIRED`, which put the pre-flight ahead of the composition-root refusal for a short window. That ordering was deliberate rather than a race: the pre-flight is a separate container that exits non-zero and blocks api, worker and alerts, so the stack already refused to start without them, and when the `container.ts` refusal landed the contract check extracted it, found it already present, and passed. The two converged instead of colliding.

### D-255 · The environment-contract gate's first catch was `SMTP_USERNAME`
**Status:** Fixed — the reason the gate in D-252 pays for itself immediately

`compose.prod.yml` and `docker/.env.prod.example` passed **`SMTP_USERNAME`**. `config.schema.ts` declares **`SMTP_USER`**.

Compose would have set a variable nothing reads and left the real one absent. `config.mail.smtpUser` would be `null`, SMTP authentication impossible, and **every verification email and every password reset undeliverable** — the entire acquisition funnel dead, behind green probes, with `mail.send` resolving and the breaker never opening. It is the D-226 failure with the fix in place and the name misspelt.

**Nobody would have found this by reading either file.** Both are internally consistent and both look right. It was found by a program comparing them, on the first run, before the code shipped. That is the argument for the gate stated as cheaply as it can be stated.

### D-256 · Four schema variables production passed by accident of their defaults
**Status:** Fixed — `docker/compose.prod.yml`

The contract check flags a variable that `config.schema.ts` declares and `compose.prod.yml` neither passes nor explains. It found four. Two were genuinely fine and are now recorded as decisions rather than omissions; two were live defects.

**`TRUSTED_PROXY_HOPS` — a defect.** Left unset, `trustProxy` is `false`, so `request.ip` is **caddy's container address for every request**. Every IP-keyed rate limit — signup 3/h, login 5/15min, forgot-password 3/h — would key on one shared bucket: the first few users of the hour exhaust it and everyone else is refused, while an attacker is metered alongside them rather than separately. A limiter that is installed, green, and metering the wrong thing. Exactly one proxy fronts the API in this stack, so the value is 1. `TRUSTED_PROXY_CIDRS` would identify the proxy rather than count hops and is generally preferable, but Docker's bridge address for the caddy container is not stable across a `down`/`up`, and a CIDR that stops matching **fails open** to the socket address with no error. A hop count cannot go stale that way.

**`DRIZZLE_MIGRATIONS_DIR` — latent.** The schema default `./drizzle/migrations` is correct only while the process's working directory is `/app`. That is true of every command in the file today and it is a *deployment* fact, not a code fact: a `working_dir:` added to one service later would make the readiness check report "no migrations found" — a health endpoint lying about schema state. Now passed as an absolute path.

**`DATABASE_SSL_CA` / `DATABASE_SSL_INSECURE` — passed through, unset.** Postgres is a container on an `internal: true` network with no published port and no route out, so `DATABASE_SSL=false` is a statement about this topology. Passing the pair explicitly (bare `KEY:` form, so absent stays absent) means the escape hatches are visible at the moment someone moves the database to a managed host. Verification is on by default; the only way to the old `rejectUnauthorized: false` behaviour is to type `DATABASE_SSL_INSECURE` into `.env.prod`, where a reviewer reads it. **The `rejectUnauthorized: false` hazard itself is already fixed in `src/platform/db/pools.ts` under D-238 and was not reintroduced here** — no file in this wave sets it.

### D-241 · The mastery read-modify-write was a lost update; the write is now a compare-and-set
**Status:** Active
`chapter_mastery.mastery_score` is a LEVEL, not a tally: `practice.submitSession` read the current value, blended the session into it with an EMA, and wrote the result outright. The read happened before the transaction opened. Two submissions on the same chapter therefore both blended from the same prior value and the second write discarded the first — **one EMA step where two occurred**.

Meanwhile `attempts` incremented in SQL (`attempts + $n`) and was correct throughout. So the row ended up permanently disagreeing with itself: two attempts recorded, one attempt's worth of movement, every number individually plausible. No error, no log line, no failing test. A student on a flaky connection whose client retries, or one with two tabs, produces it.

**The fix keeps the read where it is and makes the WRITE conditional.** `upsertMastery` takes `expectedPreviousScore` — the value the caller computed from — and its `ON CONFLICT DO UPDATE` carries `setWhere mastery_score = <that value>`. Postgres takes the row lock and re-reads the row before evaluating that predicate, so a concurrent transaction's committed write IS visible to it: the loser matches nothing, writes nothing, and is told. `expectedPreviousScore === null` means "the caller saw no row", so the conflict branch is refused outright (`where false`) — reaching it means somebody inserted first.

**The read deliberately stays outside the transaction.** `readMastery` is bound to `learner.service.getMastery`, which runs on the same `core` pool the submission transaction already holds a connection from. Issuing it inside would hold two `core` connections per submission, and enough concurrent submissions would deadlock the pool against itself. The compare-and-set is what makes the pair atomic without nesting a connection inside a transaction.

`expectedPreviousScore` is **required, not optional**. An optional field with a permissive default is how this defect comes back: every existing call site keeps compiling, the compare-and-set degrades to an unconditional overwrite, and the lost update returns silently.

A refused set throws `StaleMasteryError` rather than returning, because returning would COMMIT the responses, the session and the XP row around a mastery step that never landed. The throw rolls the attempt back; `submitOnce` re-reads, recomputes and retries up to three times, then returns a 409 the client can retry. D-056 is intact — the mastery write is still enlisted in practice's single submission transaction through the opaque `TransactionToken`, and no second transaction is opened.

### D-242 · The daily XP cap could be exceeded by concurrent submissions; a per-student advisory lock closes it
**Status:** Active
The cap is `min(earned, 200 - alreadyEarnedToday)` and `xp_ledger` is append-only, so `alreadyEarnedToday` is a SUM over rows. That sum was taken **before the transaction opened**. Two submissions arriving together both summed the same day, both found the same room, and both wrote it — 200 became 400.

**Moving the sum inside the transaction is not sufficient, and this is the part worth recording.** Under READ COMMITTED — Postgres's default and this application's — a transaction cannot see another's uncommitted insert no matter when it looks. Both would still sum the same total. There is no row to lock either, because the row that matters has not been inserted yet.

So the fix is an explicit `pg_advisory_xact_lock`, taken as the **first statement in the transaction, before any read that is acted on**, keyed by `(PRACTICE_SUBMISSION_LOCK_CLASS, hashtext(student_user_id))`. Held to COMMIT or ROLLBACK, so there is no unlock to forget and no path — including a throw — that leaks it. Two students never wait on each other; one student's concurrent submissions do, which is exactly the case being made correct. The two-argument form is a namespace: advisory locks share one global 64-bit space, and a bare `hashtext` of a user id would collide with any future feature locking on the same id, presenting as unrelated requests blocking each other.

Both halves are load-bearing and both were mutation-proved. Removing the lock while keeping the in-transaction read turns the test red (280 against a 200 cap, 6 runs out of 6). Keeping the lock and moving the read back outside the transaction also turns it red.

The retention schedule is read under the same lock for the same reason: SM-2 state is a function of the previous schedule, and two submissions reading the same one produce one review step for two sessions.

### D-243 · A negative attempt increment is refused at the domain boundary
**Status:** Active
`nextAttemptCount` has always rejected a negative increment and was **never on the write path**. The write path is `learner.service.updateMastery` -> `repository.upsertMastery`, which increments in SQL precisely so concurrent writers cannot lose the update — and SQL adds a negative number without complaint.

`assertAttemptIncrement` now runs in the service, on every call, whether or not the row already exists, and returns the increment so it can be used inline — which makes "the value that was validated is the value that was written" true by construction rather than by two adjacent statements agreeing.

See **D-245** for a correction to the reasoning originally recorded under this entry.

### D-244 · A PATCH that changes nothing writes nothing
**Status:** Active
`students.updated_at` moved on every `updateProfile` call, including a PATCH with an empty body and a PATCH re-sending the values already stored. Both are the NORMAL case on a mobile client: a settings screen posts its whole form on save whether or not a field was touched, and a dropped connection makes the app resend it.

The cost is not the write. It is that `updated_at` stops meaning "when this profile last changed" and starts meaning "when it was last saved over" — and it is read as the former. Nothing fails; the column simply becomes a timestamp of client behaviour.

Two guards, because there are two shapes of no-op. An empty PATCH issues **no statement at all**. A PATCH that mentions fields adds `or(<field> IS DISTINCT FROM <value>)` to the WHERE, so the UPDATE matches nothing when every value is already stored. `IS DISTINCT FROM` rather than `<>`: the columns are NOT NULL today, but `<>` on a null is null, which a WHERE reads as false, so a nullable column added later would silently become unpatchable. The UPDATE matching nothing is ambiguous — "no such student" and "nothing to change" look identical — so a fallback SELECT disambiguates them, and it runs only on that path.

### D-245 · The stated reason for D-243 was wrong; the database was measured instead
**Status:** Active
D-243's original note claimed the `chapter_mastery_attempts_check` CHECK (`attempts >= 0`) does not close the hole, reasoning that it fires only when the RESULT goes below zero — so `attempts = 7` with an increment of `-3` would land 4 and be accepted. **That is false for the statement this code actually issues**, and the probe is one line:

```
insert into t (..., attempts) values (..., -3)
  on conflict (...) do update set attempts = t.attempts + -3;
-- ERROR: new row violates check constraint
-- DETAIL: Failing row contains (1, 1, -3).
```

Postgres evaluates a CHECK when it FORMS the tuple, before it detects the conflict, and `upsertMastery` puts the raw increment in the INSERT's VALUES. A negative increment therefore trips the constraint every time, whatever the stored count is.

**The guard is still right, for two smaller and true reasons.** Without it the failure is an unhandled driver error escaping the repository — a 500 naming an internal constraint — where with it the caller gets a named `ValidationError`, a 400 that states the rule. And the constraint's protection is incidental to the statement's shape: rewrite `upsertMastery` as a plain UPDATE, which is a reasonable change once every row is guaranteed to exist, and `7 + (-3) = 4` really would be accepted silently, with the evidence label a parent reads computed from the smaller count.

**This is the ninth-instance pattern inverted, and it is worth naming.** The catalogued failure mode (D-214) is enforcement that looks installed and enforces nothing. This was the mirror image: a rationale asserting a gap that did not exist, used to justify a guard that is worth having anyway. It is just as dangerous, because the next reader who verifies the claim finds it false and may delete the guard along with the reasoning. **A decision note is a factual claim about the system and is subject to the same standard as a test.**

### D-246 · Concurrency is proved with a barrier on an injected seam, not with two awaits
**Status:** Active
Both D-241 and D-242 are invisible to a serial submission by construction: a lost update needs two readers of the same value, and a jointly-exceeded cap needs two submissions. Every pre-existing test submitted one session at a time, which is why both defects shipped under a green suite. A test that `await`s one submission and then the next proves only that the arithmetic is right, which was never in doubt.

`practice.concurrency.test.ts` makes the interleaving happen on purpose. Three things hold together:

1. **A real pool with real connections** — `createDb` with `poolMax` above the party count, so each submission holds its own backend and its own transaction. One connection would serialise them at the driver and every assertion would pass vacuously.
2. **`Promise.all`**, never awaited in turn.
3. **A barrier on `readMastery`** — an already-injected seam, and the last thing a submission does before opening its transaction. It releases only once all parties have arrived, so no submission can commit before another has taken the read it will compute from.

**No `sleep` and no timeout.** The barrier is a promise resolved by the Nth arrival, so it is as fast as the database and cannot flake on a slow machine — the two failure modes a `setTimeout` would have. It **trips once and then passes through**, because D-241's fix retries and a retry re-reads mastery through the same seam; a barrier that re-armed would deadlock the retry against a party that is never coming.

The assertions are chosen so that one step and two steps are different numbers. Both sessions score zero from a seeded mastery of 1.000, so one EMA step lands 0.600 and two land 0.360 — and `attempts` is asserted in the same expectation, because the defect's real signature is the disagreement between the two columns.

The file builds its own `DbHandle` rather than starting the app container, and the D-242 case uses three DIFFERENT chapters on purpose: on one chapter D-241's compare-and-set would also force a retry, and the cap would come out right for a reason that has nothing to do with the cap.

### D-247 · Two silent truncations remain inside `practice`, reported rather than changed
**Status:** **Needs decision**
`practice.service.ts` passes two fixed limits into `content`, and both are silent partial results of the kind this audit was looking for:

- `questionsOf` requests `limit: 200` to hydrate a session's questions, commenting that this is "the whole chapter". A chapter with more than 200 active practice questions would fail to hydrate some of a session's questions, and the loop **silently skips** any id it cannot find. The student then gets a 404 on a question that is genuinely part of their session.
- `getTodaysMission` requests `limit: 100` per subject. A subject with more than 100 chapters silently omits the rest from the mission candidate set, so a due review on chapter 101 could never be chosen.

Neither is fixed here, deliberately. The obvious fix to the first — assert that every `session.questionIds` entry was hydrated and fail loudly — **changes behaviour for a case that is currently tolerated**: a question withdrawn mid-session is presently skipped, and would become a hard failure for the entire session. That is a product call about which failure is worse, not a defect fix, and it should not be made silently inside a concurrency audit. The corpus today holds 2,741 questions across 137 chapters, so neither limit is currently reachable.

### D-248 · Three unbounded reads in `content` are handed to that module's owner
**Status:** **Open — owned by another agent**
Found while tracing `practice`'s injected edges. All three are in `src/modules/content` and `src/shared/contracts`, which this change does not own, so they are reported rather than edited:

- `content.repository.findChunksByIds` builds `inArray(ragChunks.id, ids)` with **no cap on `ids`**. Its only caller is `retrieval`, so the bound is currently whatever the retrieval depth happens to be — an implicit limit, not a stated one.
- `content.service.getQuestionsForChapter` and `getHeldOutQuestionsForChapter` take `limit?: number` and default to `DEFAULT_QUESTION_LIMIT` (20), but apply **no ceiling** to a supplied value. `practice` passes 200 today (see D-247).
- `content.contract.ts` caps the chapter list at `max(200)` with `default(100)` and offers **no cursor**. A grade/subject with more than 200 chapters returns a silently partial list: the response carries no indication that it was truncated. Either paginate it or make the truncation visible in the response body.


## Identity security remediation — 11 August 2026

*Five confirmed defects in `src/modules/identity/`, plus what fixing them uncovered. Every fix in this section was mutation-proven: the defect was re-applied and a NAMED test was shown to go red. The result is recorded on each entry, because a fix nobody broke on purpose is a fix nobody has evidence for.*

### D-217 · A mail outage returned 500 on signup, after the account was already created
**Status:** Active
`identity.service.ts` awaited `mail.send` bare at three call sites — signup verification, the existing-address notice, and the reset request — with the user row committed at the line above. A provider blip therefore produced a **502 after the INSERT**: the address was taken, the caller was told the signup failed, and retrying with the same address hit the unique index. The single worst outcome in the funnel, from a transient third-party failure.

Two files stated the opposite contract in as many words — `container.ts` and `guarded-mail.ts` both promise "a mail outage must degrade to 'verification queued', never 'signup fails'". **The catch they described was never written.** The comments were the entire implementation, which is another instance of the D-214 pattern.

Every send is now issued through `deferMail`, which starts it and does not await it. `DependencyError` — and only that class — is logged at `warn` and counted under `identity.mail.deferred`; anything else is a programming error in OUR message and is logged at `error` under a **separate** metric, `identity.mail.unexpected_failure`. Folding the second into the first would hide a permanent bug inside a transient-failure dashboard.

**What "deferred" means, precisely, because it is weaker than a queue:** the send is fire-and-forget and the process may exit before it completes. That is acceptable ONLY because the recovery path does not depend on it — the verification and reset tokens are committed rows, so a resend re-mails a token that is already persisted. Losing a send costs one email, never an account. `platform/jobs` is the right home the day a resend endpoint is not enough; that is a cross-module change and was reported, not smuggled in.

**Mutation proof:** restoring `await mail.send(...)` at the signup call site turns `SIGNUP STILL SUCCEEDS WHEN THE PROVIDER IS DOWN, and the token is persisted` red (a 502 escapes), along with four sibling assertions; doing the same in `requestPasswordReset` turns `RESET REQUESTS SURVIVE THE SAME OUTAGE, with the reset token persisted` red.

### D-218 · `requestPasswordReset` and `signup` were latency oracles
**Status:** Active
Both endpoints return a **byte-identical** body whether or not the address has an account, and a test has asserted that for a long time. The **timing** was not identical: an unknown address returned after one indexed SELECT, a known one after a token INSERT **and a synchronous SMTP round trip**. Hundreds of milliseconds, measurable from anywhere on the internet, answering exactly the question the identical body exists to withhold. `login` has had a real median-ratio timing test since it was written; signup and forgot-password had none.

Closed by the same change as D-217 plus one addition: the reset token is now generated **before** the existence branch, on both paths, in the same spirit as login's dummy Argon2 verification. With the send off the request path there is no longer a term worth equalising — it was the dominant one by two orders of magnitude, and it could never have been equalised anyway, since the unknown branch has no address to mail.

**The residual is named rather than hidden.** Signup's new-account path still performs two INSERTs where the taken path performs one that fails on the unique index: about six milliseconds in the container harness, against a 150 ms defect signal. The test bounds separate the residual from the defect with two orders of magnitude of daylight, deliberately — a bound tightened to the currently-measured number is a bound that goes red on a slow agent and gets deleted within a week.

**Mutation proof:** awaiting the send in `requestPasswordReset` turns `ANSWERS A KNOWN AND AN UNKNOWN ADDRESS IN THE SAME TIME` red at a 163 ms delta against a 50 ms bound; awaiting it in `signup` turns `ANSWERS A NEW AND AN ALREADY-REGISTERED ADDRESS IN THE SAME TIME` red at 178 ms.

### D-219 · Sessions had no absolute lifetime, so a stolen token used regularly never expired
**Status:** Active
§6.1 states two rules that only mean something together — "lifetime 30 days absolute" and "extend when used and older than 24 hours" — and only the second was implemented. Renewal **replaced** `expires_at` with `now + 30 days` and **no code path ever read `created_at`**. A stolen cookie touched once inside each 24-hour renewal interval was therefore a **permanent credential**, under a comment in `validateSession` claiming an abandoned session "still dies on the 30-day ceiling". The ceiling was never checked.

There are now two bounds, and they are different kinds of thing:

| bound | value | stored where | moves? |
|---|---|---|---|
| sliding / idle | `SESSION_IDLE_TTL_MS`, 14 days | `sessions.expires_at` | pushed forward on use |
| absolute | `sessionTtlDays`, 30 days, from config | derived from `sessions.created_at` | **never** |

`created_at` is now selected on every validation and written from the **injected clock** rather than left to the column default — otherwise the anchor would carry the database's `now()` while the comparison used the application's, which is a two-clocks bug whose symptom is a session that never expires and which no `FixedClock` test could observe.

The rule is enforced **twice on purpose**: every write is clamped to the ceiling (`sessionDeadline`), and every validation checks the ceiling independently (`isPastAbsoluteLifetime`). The clamp protects rows written by this version of the code; the check protects rows already in the table, every one of which carries an unclamped `expires_at`. A clamp alone would leave the existing sessions immortal.

**The cookie's `Max-Age` now has a stated authority.** It carries the **absolute** deadline, and it must: a cookie set to the idle deadline would be discarded by the browser two weeks in, signing out an active user whose server-side session was alive and renewing. The two therefore agree, because `expires_at` is clamped to the same ceiling and can never be later. The **server is authoritative regardless** — `maxAge` is a hint, and `validateSession` checks both bounds against the database on every request.

**Also found:** the first draft of the ceiling test advanced the clock 25 days in ONE hop and then asserted the clamp. With a 14-day idle window that session is dead on the idle bound long before the clamp matters, so the test asserted nothing about the thing it was named for. It now walks forward in two 13-day hops, each of which renews.

**Mutation proof:** dropping the `isPastAbsoluteLifetime` check and restoring the unclamped renewal deadline turns `KILLS A CONTINUOUSLY RENEWED SESSION AT THE ABSOLUTE CEILING` red (the session is still alive past day 30) and `never writes an expires_at past the absolute ceiling` red (day 40 written where day 30 was required).

### D-220 · `POST /auth/logout` was unauthenticated, unthrottled, and reached the `auth` pool
**Status:** Active
Logout is deliberately not behind `requireSession` — logging out of an already-dead session must succeed, not 401 — which made it the one endpoint that is simultaneously anonymous and able to reach the database. The database it reaches is the **`auth` pool**, the pool §3.1's bulkhead exists to keep free so that login always has a connection. A loop from one host with no credentials could empty it.

It is now rate limited by IP at 30/hour, and **the order of two lines is the fix**: the limiter runs FIRST and the empty-token return runs SECOND, so a flood is counted whether or not it carries a cookie, while a cookie-less request touches the cache and nothing else — it consumes no `auth` connection at all.

The counter has its **own key namespace** rather than sharing `login:ip:`. A shared counter would let a flood of anonymous logouts spend the budget a real user needs to sign IN: throttling the cheap unauthenticated endpoint must never be able to lock anybody out of the expensive authenticated one.

**Mutation proof:** deleting the `limiter.consume` line turns `RATE LIMITS logout by IP` red.

### D-221 · `hashIp` was unsalted, so the hash was decorative
**Status:** Active
`sessions.ip_hash` was `sha256(ip)`. There are 2^32 IPv4 addresses; a plain SHA-256 over that space is enumerable end to end on a laptop, so anyone holding the column held the addresses — pseudonymised in name only. The same digest was also a rate-limit **cache key**, which made it a **stable cross-store correlator**: a cache dump and a database dump join on it perfectly.

The salt is now a **required parameter with no default**, threaded from the composition edge through `createIpHasher` so that no request-path call site holds the secret. A default would be the regression: one call site omitting it would silently reproduce the original digest and every test would still pass.

**Rotation resets every rate-limit counter and orphans every stored `ip_hash`. That is accepted.** It is the same loss a process restart already causes for the in-process fallback counters; the counters are 15-minute and 1-hour windows whose worst case is one extra window's budget for an attacker who cannot observe the rotation, and `ip_hash` is diagnostic data — not a credential and not a foreign key. Rotate at will; do not rotate hourly.

**Mutation proof:** dropping the salt from the digest turns `IS NOT THE BARE SHA-256 OF THE ADDRESS` and `produces a different digest under a different salt, so rotation works` red. Note that the four pre-existing `hashIp` assertions — deterministic, differs between addresses, 32 hex characters, does not contain the input — **all pass against the unsalted version**. Every property a hash is supposed to have, and not one of them was the property that mattered.

### D-222 · The salt separator was a raw NUL byte in a source file
**Status:** Active
The first cut of D-221 concatenated salt and value with a **literal NUL control character** in the template literal. The domain separation is right and is kept: without a separator, `('ab', 'c')` and `('a', 'bc')` produce the same digest, so a rotated salt can collide with the salt it replaced, and NUL is the one byte that occurs in neither an IP string nor an email address.

The **encoding** was wrong. A raw NUL makes `git` and `grep` classify the whole file as binary — `grep` reported "Binary file matches" and refused to print, while the diff rendered the byte as a space, which is how it survived review. It is now written as an escape: identical bytes hashed, and a file the tools will still search. **A file that cannot be grepped is a file nobody reviews.**

### D-223 · The IP-hash salt is not read from `process.env`, and the durable fix is reported
**Status:** CLOSED by D-273 — `IDENTITY_IP_HASH_SALT` is in `config.schema.ts`, threaded through `app/routes.ts`, and documented in both `.env.example` files. It is deliberately NOT a production boot refusal yet; that residue is D-280 item 1.
The first cut resolved the salt as `deps.ipHashSalt ?? process.env.IDENTITY_IP_HASH_SALT`, which `no-restricted-properties` rejects in as many words: the environment is parsed **once**, in `platform/config`, into a frozen object, so the set of variables a deployment depends on is enumerable in one file rather than discovered by grep. A module reaching around that is how a deployment acquires an undocumented required variable.

The env read is gone. The salt arrives as an optional dependency at the module boundary, and when it is absent the module logs at `warn` and falls back to `UNCONFIGURED_IP_HASH_SALT`, a build constant documented as **not secret**. That is a real but **partial** fix, labelled as such: it defeats a generic precomputed rainbow table over the IPv4 space and defends against nobody who has the source.

A build constant is nonetheless the right fallback rather than a per-process random one. The digest is a rate-limit cache KEY, so a salt that differed per instance would silently convert the shared cross-instance counter into a per-instance counter — the D-034 security downgrade, arriving by accident and with no warning line.

**Owed by another owner:** an `IDENTITY_IP_HASH_SALT` entry in `platform/config/config.schema.ts`, threaded through `app/routes.ts` into `createIdentityModule({ ipHashSalt })`. Until it lands, the warn line is the visible marker of the gap.

### D-224 · Three smaller findings sit outside `identity` and were reported, not reached across for
**Status:** **Needs platform / app owner**
All three were confirmed and none is in a file this module owns. They are recorded here so they are not lost between agents:

| finding | file | state |
|---|---|---|
| `retry-after` reports the **full window** rather than the time remaining in it | `src/platform/rate-limit/limiter.ts` — `new RateLimitError(rule.windowSeconds, …)` | unfixed; leaks nothing, but tells a well-behaved client to wait an hour when the window resets in seconds |
| inbound `x-request-id` is accepted **unbounded** — a client may supply a megabyte, which then rides every log line for that request | `src/app/plugins/request-id.ts` | unfixed; needs a length cap with a fresh id substituted past it |
| the header comment claims `tenant_id` **is nullable**; the column is `.notNull().default(DEFAULT_TENANT_ID)` | `src/platform/db/schema/identity.ts` | stale comment only — the D-073 reasoning it points at was implemented and the comment was not updated with it |

### D-225 · The harness's mail fake is why two live defects were invisible to 300 passing tests
**Status:** Active
D-217 and D-218 sat in the hottest path in the product with a full service suite, a routes suite and a dedicated security suite over them. Neither was visible, and the reason is one object: the harness substitutes `RecordingMail`, whose `send` never fails and returns in microseconds. Against that fake **a bare awaited send and a deferred one are indistinguishable** — the outage branch never executes and the latency term is exactly zero.

The lesson generalises past mail. **A fake that only models the success path can only test the success path**, and the defences that most need testing — degradation, timing symmetry, back-pressure — are all properties of the failure path. A fake with no failure mode silently narrows a suite to the cases nobody was worried about.

`identity.mail-path.test.ts` supplies the fake that can see both: `LatentMail` has a `failWith` mode (transient outage vs programming error) and a `delayMs` that models the SMTP round trip. **No test in it sleeps** — the delay lives inside the port, where it models a real dependency, and the deferred-failure assertions are made deterministic by awaiting the same promise `deferMail` attached its handler to, never by waiting for a timer.

---

## Platform hardening wave — 11 August 2026 (D-226 to D-240)

Eight confirmed defects in `platform/mail`, `platform/db`, `platform/metrics`, `platform/jobs`, `app/server.ts`, `app/health.ts`, `app/container.ts` and `scripts/clear-content.ts`. **Every one was proved by re-applying it and watching a named test go red** — the D-214 standard. Seven of the eight are the same shape the audit wave named: enforcement that looks installed and enforces nothing. One of them, D-226, is worse than that: it was a subsystem that did not exist at all, behind an interface that said it did.

### D-226 · There was no mail adapter. Production printed verification links to stdout and delivered nothing
**Status:** Resolved

`src/platform/mail/` contained a port, a guard and a CONSOLE adapter. There was no real implementation of any kind, and `container.ts` defaulted to `createConsoleMail()` **with no environment gate**. So in production:

- `signup` wrote a verification token to the database and printed its link to stdout. Nobody could ever verify an address.
- `forgotPassword` did the same with a reset link.
- `mail.send` resolved, so the breaker never opened, no metric moved, and every health probe stayed green.

**The entire acquisition funnel was dead and the system reported itself perfectly healthy.** `RESEND_API_KEY` was being passed by the deployment and silently ignored, which is how it survived review: the variable's *presence* was the evidence people were reading.

**SMTP, not a vendor HTTP API.** The owner intends to send through Google Workspace, so the transport is SMTP with an app password (`smtp-mail.ts`, `mail-templates.ts`). That is not a compromise — it is the version with the fewest moving parts: no SDK, no vendor auth model, no webhook, and changing provider is four environment variables and no code. **The `MailPort` shape is unchanged**, so nothing upstream of the composition root knows this landed.

**The transport is injected**, and that is what makes it testable: `createSmtpMail` takes a one-method `MailTransport`, and `createNodemailerTransport` is the only function that touches nodemailer. **No test in this repository opens a socket to an SMTP server, and the seam is what guarantees it rather than a convention.** 13 tests in `smtp-mail.test.ts`, including SMTP header injection (a `\r\n` inside a signup-form email address is how `Bcc:` gets appended) and the missing-field case, whose signature without a guard is a delivered email reading `undefined` where the link should be.

**`createContainer` now refuses to boot in production without SMTP** — the same treatment `embed`, `llm` and `payments` already had, and for the same reason: *a console mailer in production is not a degraded mode, it is a silent total failure of signup and password reset.* The error names which of the four variables is missing, because `SMTP_FROM` is genuinely separate from `SMTP_USER` (Workspace allows sending as an alias) and "I set the credentials" and "I set the visible From" are different states.

**Proof:** removing the production gate turns `boot-gates.test.ts > production refuses to boot without SMTP` red (6 tests). Making `send` a no-op turns `smtp-mail.test.ts > sends ONE message per call, with the configured From` red.

### D-227 · `trustProxy: true` collapsed every IP-keyed rate limit to no limit at all
**Status:** Resolved

`server.ts:53` passed `trustProxy: true` to Fastify. That means *believe the `X-Forwarded-For` header from anyone*, and `request.ip` is what signup (3/h), login (5/15min) and forgot-password (3/h) are all hashed from via `hashIp`.

A client that sends a different forged header on each request therefore **gets a different bucket on each request**. All three limits become unbounded, with no error, no log line and no metric — the limiter is still installed and still counting, and counting a fresh key every time.

The fix is `config.http.trustProxy`, a `false | readonly string[] | number` union fed by `TRUSTED_PROXY_CIDRS` **or** `TRUSTED_PROXY_HOPS` (never both — Fastify takes one value, so with both present one would be silently ignored). **The union cannot express `true`**, so "believe everyone" is closed in the type rather than in a review comment.

**The default is to trust nobody**, and that is the safe wrong answer: unconfigured behind a proxy, the whole fleet shares one bucket and the limits are too STRICT — a visible, complainable failure. Trusting a forged header is an invisible one, and **between a default that over-blocks and a default that silently stops blocking, only one of them gets noticed.**

**Proof:** restoring `trustProxy: true` turns `trust-proxy.test.ts > a forged X-Forwarded-For does NOT change the rate-limit key` red — three rotated addresses become three distinct `hashIp` buckets instead of one.

### D-228 · The pool arithmetic counted one process out of two, and `DATABASE_POOL_MAX` was read by nothing
**Status:** Resolved

`pools.ts` carried the sentence *"44 total, comfortably inside a default `max_connections` of 100 with room for administrative access."* 44 is **one** process's sum. There are two: `main.ts` and `worker-main.ts` both call `createContainer`, which both calls `createDbPools`, which builds all four pools in each. The real figure was **88 of 100** with a single replica of each, and **132** during a rolling api deploy, which by construction runs the old and new api at once.

Crossing `max_connections` does not present as one slow module. It is `FATAL: sorry, too many clients already` on every checkout in every pool at the same instant, **plus a `psql` that cannot connect to diagnose it** — the exact failure §3.1's bulkheads exist to prevent, arrived at from the server side, with the bulkheads working perfectly throughout.

`DATABASE_POOL_MAX` was parsed, validated, and consulted by no code at all.

Two corrections, in `pool-budget.ts` as a **pure, tested function** — because the thing that was wrong before was arithmetic in a comment, and a comment cannot be tested:

1. **Role awareness.** An api only ENQUEUES onto `worker` (one indexed INSERT, plus the metrics sink), so it is capped at 2. A worker serves no login, so `auth` is capped at 2 and `core` at 4. `ai` is deliberately NOT capped in the worker: starving a vector pool is a silent quality regression, not a loud failure.
2. **An enforced ceiling.** `DATABASE_POOL_MAX` is now the per-process cap, and the set scales down **proportionally** when the role profile still exceeds it — because the ratios between the four pools ARE the §3.1 policy, and taking the excess off the biggest pool would silently rewrite that policy at whichever ceiling an operator happened to pick. Floor of 1: a pool with zero connections is not a smaller bulkhead, it is a module that cannot run, presenting as an unexplained hang.

At the defaults: **api 40, worker 20, 60 of 100**, leaving room for a rolling deploy's overlap and for `psql`. Total across replicas cannot be enforced from inside one process, so the header states it as the operator's sum rather than assuming it.

**Proof:** restoring the api's `worker` cap to `null` turns `health.test.ts > reports each connection pool separately` red (`worker:2` becomes `worker:6`) and `boot-gates.test.ts > keeps two processes inside a default max_connections of 100` red. Ignoring the ceiling turns `pool-budget.test.ts > never opens more than DATABASE_POOL_MAX across all four pools` red at every one of the 97 ceilings it sweeps.

### D-229 · The health endpoints handed the database host, port and username to anyone
**Status:** Resolved

`db/health.ts` carried `error: string | undefined`, populated from `cause.message` and rendered **verbatim** into the body of both `/health/ready` and `/health/deps`, which are reachable by anything that can open a socket to the service. The comment beside it said "log-safe; never the connection string, which carries the password" — true, and beside the point, because a node-postgres connection failure reads:

```
connect ECONNREFUSED 10.0.3.14:5432
password authentication failed for user "foxxy_app"
no pg_hba.conf entry for host "10.0.1.7", user "foxxy_app"
```

Host, port, username, and the private address of the application itself, to an unauthenticated caller, **at the exact moment the database is down and somebody is looking for a way in.** There was already a comment at the old `db/health.ts:107` acknowledging the risk. The code did not act on it — the guard had been written as prose, which is this codebase's signature defect.

Now: `/health/ready` returns `{ status }` **and nothing else**. It is consumed by a load balancer, which reads the status code; the body was for humans, and the humans it reached were not only ours. `/health/deps` may say WHICH dependency is unhealthy through a **closed union** — `'unreachable' | 'timeout' | 'schema_incomplete'` — which is enough to route an operator to the right runbook page and **cannot grow a hostname, because it is not a string.**

**Proof:** re-rendering `cause.message` into either body turns `health.test.ts > leaks no host, port or username with the database down` and `> classifies the failure without a vendor message` red.

### D-230 · Readiness never probed the cache, and eviction silently disabled rate limiting
**Status:** Resolved

Two fail-open blindspots with one root: nothing anywhere asked whether rate limiting still worked.

**(a) Readiness ignored the cache.** `platform/rate-limit` is deliberately built to survive Valkey's loss — when `cache.incr` throws, counting moves into process memory so one dead container cannot take authentication down. That trade is correct and its own header states the cost: *"the fallback is DELIBERATELY WEAKER: per instance, not global, so N instances admit up to N x the limit."* What was missing is the other half. **A replica in that state stayed in the load balancer's rotation indefinitely**, answering login and signup on a counter that resets whenever it restarts. Nothing removed it, because nothing asked.

`createCacheProbe` now runs in `/health/ready`, against the **raw** cache rather than the guarded one — probing through the breaker would report the breaker's state rather than the cache's, so a replica could never observe the recovery that would return it to rotation. It **reads one key and never writes**: a `set` probe would add a write to an `allkeys-lru` store on every health check from every replica, which is load applied in proportion to how many things are watching it.

**(b) Eviction had no signal at all.** Valkey runs `allkeys-lru`. A rate-limit counter is almost by definition among the least recently used keys — touched a handful of times, then not again for fifteen minutes. When one is evicted mid-window the next `incr` returns 1 and the limiter reads it as a first attempt: **an attacker on their fifth login attempt is back to their first.** There is no error. The cache is up, `incr` succeeded, the breaker is closed, and the in-process fallback — which *does* have a metric — never activates. **Rate limiting silently stops limiting while every signal in the system says it is working.**

`WindowDeadlines` remembers, per key, when the window it just counted into is due to close; a later `incr` returning 1 before that deadline means the counter was destroyed by something other than time. `rate_limit.counter_evicted` is emitted, distinct from the fallback metric because "Valkey is gone" and "Valkey is up and shedding our keys" are different runbook pages. It is a **hint, not a source of truth**: it can only ever miss evictions (a key evicted after its window closed is indistinguishable from one that expired), never invent one. **A metric that under-reports is actionable; one that over-reports gets muted.** A deliberate `reset()` forgets the deadline, so a successful login does not report an eviction — a signal that fires on the happy path is a signal nobody reads.

**Proof:** deleting the cache check from `/health/ready` turns three tests in `health.test.ts > GET /health/ready — with the CACHE down` red. Deleting the `observeWindowStart` check turns `counter-eviction.test.ts > emits the metric when a window restarts before its deadline` red.

### D-231 · `/health/ready` accepted a half-migrated database
**Status:** Resolved

`db/health.ts` decided readiness with `migrationsApplied = (rows[0]?.count ?? 0) > 0`. **One row.** A database with `0000_baseline` applied and the other five pending satisfied it, so readiness returned 200 and the load balancer routed live traffic into a schema with no `practice`, `parent`, `billing` or `foxy` tables.

The failure then arrives as 500s on whichever endpoint touches a missing table first — **which reads as an application bug rather than as a deploy that did not finish**, and is therefore debugged in the wrong place for as long as it takes somebody to think of it. The migration step is deliberately not run on boot (see the Dockerfile), so "code deployed, migrations not" is a **reachable state by design**, and readiness is the thing that was supposed to notice.

`migration-manifest.ts` reads drizzle's own journal — `<migrations>/meta/_journal.json`, whose `when` values are exactly what the migrator writes into `__drizzle_migrations.created_at`, so the comparison is set membership on a number, with no hashing and no per-file reads. The folder travels with the image (`COPY drizzle ./drizzle`) precisely so the SQL matches the code, and this reads the same copy, so the expectation and the artefact cannot drift. **Read once at boot, never per probe**: a readiness endpoint that hits the filesystem per request is one a health checker can turn into disk load.

**Extra applied migrations are not a failure.** A rolling deploy runs the new schema alongside the old code by design, and failing readiness on the old replicas during that window would take the service down in the middle of a successful deploy. Missing is fatal; extra is expected.

Production **refuses to boot** when the journal is unreadable, because the fallback is the old useless rule, and *a fallback that is right in development and wrong in production, with no way to tell which one you are running, is the same defect wearing a different hat.*

**Proof:** restoring `applied.length > 0` turns `migration-manifest.test.ts > REFUSES a half-migrated database` and `> refuses when a SINGLE migration in the middle is missing` red. The second is the one row-counting can never see: the count is 5, which is emphatically greater than zero.

### D-232 · A breaker opening could sit in memory indefinitely — the failure suppressed its own alert
**Status:** Resolved

`postgres-metrics.ts` flushed on two events: 100 buffered observations, or shutdown. Nothing else.

Take the single event this subsystem exists for. §5: *"a breaker that opens without anyone knowing is a silent outage."* The transition emits **one** counter. It lands at position 7 of 100 and stays there — **because the dependency is now down, so the traffic that would have filled the buffer has stopped.** The failure suppresses the very observations that would have flushed the record of it. The alert evaluator polls `metrics_events` and sees nothing. If the process is then killed rather than shut down cleanly, the observation is lost outright and the incident has no trace at all.

Three triggers now: **count** (100, unchanged, for throughput), **interval** (5 s while anything is buffered, which bounds the AGE of an observation — the property alerting actually depends on), and **severity** (immediate, for the observations an alert is written against: breaker transitions, dead jobs, degradation activations, PII scrubs, and all three rate-limit fallback/eviction metrics).

The severity set is a set of **names**, not a `severity` field on `MetricEvent`. A field would have to be set correctly at every call site including the ones written next year, and **the failure mode of forgetting it is exactly the silence this closes.** A name is already an API — dashboards are written against it — so a rename that missed the set would break a dashboard first, loudly.

The timer is armed lazily and disarmed when the buffer empties (a permanently-armed timer is a wakeup every five seconds forever in every process, bought for no observability), is `unref`'d (a metrics sink must never be why a container refuses to exit), and is **injected**, so "five seconds elapsed" is a function call and plan §9.5's ban on sleeping in tests holds.

**Proof:** removing the severity check turns `postgres-metrics.test.ts > ONE breaker-open reaches the table WITHOUT 99 companions` red. Removing the interval turns five tests under `> the interval trigger` red. Making *everything* immediate turns `> does NOT flush immediately for an ordinary observation` red — the control that stops the fix from restoring the per-observation insert storm the buffer exists to prevent.

### D-233 · `succeed`/`fail` raced the reaper, and a job's final state could flip to the wrong answer
**Status:** Resolved

`postgres-queue.ts` carried this comment above `fail`:

> *"The decision is made in SQL with a CASE rather than by reading `attempts` and writing back, because a read-modify-write here races with the reaper — which is also allowed to change this row's status."*

The code directly beneath it did a `SELECT`, then an `UPDATE`, keyed on `id` alone. **It described the race it was going to lose, and then lost it.** `succeed` had the same fence-free `where id = $1`.

The race is not exotic. A handler may legitimately outrun the 120-second lock timeout — a large digest, a slow provider. `reapStuck` returns the row to `pending`, a second worker claims it, and two workers are now running the same job. Both finish, and whichever finishes last wins:

- a stale `succeed` overwrites the new owner's `running`, whose later `fail` then marks a genuinely successful job `failed` and schedules a **third** run; or
- a stale `fail` overwrites a genuine `succeeded`, so the final state of a job that worked says it did not.

**At-least-once execution is an accepted, documented property of this queue. A final state that is wrong is not**, and handler idempotency cannot fix it, because the corruption is in the queue's own bookkeeping rather than in the side effect.

Both methods are now one statement fenced by `and status = 'running' and locked_by = <lease> and locked_at = <lease>`, and `fail` really does decide `dead` versus `failed` with a `CASE` over the row's own columns, returning the status the database actually chose rather than the one we predicted. The comment and the code now agree.

**The fence is structural, not remembered.** `succeed`/`fail` take a `ClaimedJob` — a type whose only producer is `claim` — instead of a `jobId: string` that any id from anywhere satisfied. `ClaimedJob` is separate from `JobRecord` deliberately: a handler receives the work, not the bookkeeping, so `JobHandler` stays `(job: JobRecord)` and **nothing under `src/modules/` had to change.**

`lease_lost` is a third `FailureOutcome` rather than an exception, because it is an expected benign race and a throw would make the runner's `catch` treat a successfully-avoided double-write as a job failure. The runner emits `platform.job.lease_lost` and logs at `warn`: nothing is broken, but the lock timeout is shorter than that kind of job actually takes, so the handler is running twice on every occurrence.

**Proof:** removing the `locked_by`/`locked_at` conditions turns `job-queue.test.ts > refuses a stale succeed, leaving the new owner running` and `> refuses a stale fail, so a succeeded job cannot be flipped back` red, against a real Postgres with the reaper actually reclaiming the row between claim and completion. A control test asserts the CURRENT owner still completes normally — a fence that rejected everything would pass the first two and break the queue entirely.

*Found while fixing it:* `JobRow.locked_at` was declared `Date` and the driver hands back a string. `run_at` and `created_at` carry the same untrue annotation and have never been caught, because nothing ever calls a method on them. The lease is different — it is formatted back into the next statement — so it is typed honestly as `Date | string` and normalised once, in `toRecord`.

### D-234 · `clear-content` had no production guard while `seed-dev` did
**Status:** Resolved

`seed-dev.ts` has refused to run against `NODE_ENV=production` since it was written. `clear-content.ts` did not, and **it is by far the more dangerous of the two.** Seeding production adds six fake chapters: embarrassing, and reversible. `clear-content` issues `TRUNCATE ... CASCADE` over six content tables, and the cascade reaches `chapter_mastery` — **every student's learning history** — with no confirmation step and no backup step.

The realistic accident is not somebody typing this at a production shell. It is `DATABASE_URL` still exported in a terminal from an earlier task, or a `.env` pointing at staging-which-is-actually-production, and the command running **exactly as designed** against the wrong database.

The guard is an **exported pure function**, `assertNotProduction(env)`, not an `if` inside the non-exported `main`. An inline check could only have been tested by actually running the TRUNCATE, so it would have shipped untested — which is the shape of every defect in this codebase's audit history. It checks `NODE_ENV`, the same signal `seed-dev` and the container's boot gates use, so there is one answer in this codebase to "is this production" rather than three.

**Proof:** deleting the throw turns `clear-content-guard.test.ts > THROWS for production — the named test the guard exists for` red.

### D-235 · The wave stayed inside its ownership boundary, and one design choice exists only because of it
**Status:** Active — a note on scope

Everything above lives in `platform/mail`, `platform/db`, `platform/metrics`, `platform/jobs`, `platform/cache`, `platform/rate-limit`, `platform/config`, `app/server.ts`, `app/health.ts`, `app/container.ts`, `src/worker-main.ts` and `scripts/clear-content.ts`. **No file under `src/modules/`, `src/app/routes.ts`, `src/app/plugins/`, `docker/` or `scripts/ops/` was touched.**

That constraint produced a better design once. D-233 introduced `ClaimedJob` as a subtype rather than adding two required fields to `JobRecord`, because the latter would have forced an edit to `modules/notify`'s test fixture. The subtype turns out to be the stronger form anyway: a handler has no use for the lease, and confining it to the completion methods is what makes "you cannot complete a job without holding its lease" a property of the type rather than of a convention.

Mechanically updated for changed signatures, all outside module code: `tests/integration/job-queue.test.ts`, `src/platform/db/__tests__/pools-startup-options.test.ts`, `src/platform/jobs/__tests__/job-runner.test.ts`, `eval/retrieval/{harness,sparse-probe,sparse-recall}.ts`, and `tests/integration/{hnsw-ef-search,pool-bulkhead,retrieval-search}.test.ts`.

### D-236 · The drizzle-orm advisory was assessed and the upgrade DECLINED, with the reasoning recorded
**Status:** Active — deliberately not done

`npm audit --omit=dev` reports one high-severity finding: **GHSA-gpj5-g38j-94v9, SQL injection via improperly escaped SQL identifiers, `drizzle-orm <0.45.2`.** Installed is `0.38.4`.

**The exploit path does not exist in this codebase.** The advisory requires attacker-influenced text to reach an *identifier* position. There is no `sql.identifier` call anywhere in the repository, and all 23 `sql.raw` calls sit in `platform/db/schema/*.ts`, every one of them mapping a **frozen compile-time constant tuple** (`GRADES`, `SUBJECTS`, `SUBSCRIPTION_STATUSES`, `BLOOM_LEVELS`, …) into a CHECK-constraint literal list at schema-definition time. No request value reaches any of them, and none of them run at request time at all. Everywhere else, every value is a bound parameter through `sql` interpolation.

**The upgrade cost is not small.** `0.38.4 → 0.45.2` is seven minor versions of a library whose typed-query surface changes across them, and drizzle-orm 0.45 wants drizzle-kit `0.31.x` against the installed `0.30.6`. That bump regenerates the snapshot and journal format across the six existing migrations — the same `meta/_journal.json` that D-231's readiness check now reads — and verifying it means a migration round-trip against the one development database holding the corpus (137 chapters, 4,686 rag chunks, 2,741 questions, produced by a paid embedding run), which this wave is explicitly forbidden from migrating.

So, per the instruction to say so and stop rather than half-upgrade: **declined, and reported.** It should be its own change, with `db:round-trip` run against a throwaway database and the corpus untouched. Recorded here so the finding is not silently carried as "known and ignored" — it is known, measured to be unreachable, and scheduled.

### D-237 · The resilience plan's `retries` column is enforced nowhere, and it is not this wave's file
**Status:** CLOSED by D-270 — wired, with the budget/permission split that made it safe to wire at all. `payments: 0` now forbids something.

04-RESILIENCE-PLAN.md §4's timeout table has a **retries** column, and `config.schema.ts` parses it into every `TimeoutRule`: `postgres` 1, `cache` 1, `llm` 1, `embed` 2, `mail` 3, `payments` 0 (*"none on writes — retrying a payment is worse than failing it"*).

`grep -rn retries src/platform/resilience/` returns **nothing**. `port-guard.ts` applies the concurrency limit, the breaker and the timeout, and never reads `rule.retries`. The only retry machinery in the process is `platform/http`'s own `HTTP_MAX_RETRIES`, which is a different setting on a different axis.

So the per-port retry policy is a validated number that nothing consumes — the same shape as `DATABASE_POOL_MAX` before D-228, and one more instance of the pattern D-214 named. **The `payments: 0` row is the one that matters**: it reads as a deliberate safety property, and it is currently indistinguishable from every other row, all of which are equally inert.

`src/platform/resilience/` is outside this wave's ownership, so this is handed over rather than reached across for. Whoever takes it should decide explicitly between wiring `rule.retries` into `PortGuard.run` and **deleting the column from the config and from the plan** — an unwired safety setting is worse than an absent one, because it is read as a guarantee.

### D-238 · Managed-Postgres TLS accepted any certificate at all
**Status:** Resolved

`pools.ts` hardcoded `ssl: { rejectUnauthorized: false }` whenever `DATABASE_SSL` was on. **That is TLS with the authentication removed.** The connection is encrypted against a passive listener and completely open to an active one, because any certificate is accepted — including one an attacker generates. Whoever sits between this process and a managed Postgres reads every row, every session token, and the credentials in the connection string, and nothing anywhere reports it: the handshake succeeds, the queries work, and "we use SSL" stays technically true.

Verification is on by default now. `DATABASE_SSL_CA` supplies the provider's PEM for a root Node does not already trust — **that is the correct answer**. `DATABASE_SSL_INSECURE` restores the old behaviour and is named so that it cannot be read in a deployment manifest without knowing what it costs. Setting both is a boot failure: a CA plus a disabled check means the CA is verifying nothing while *appearing* to be the secure configuration.

### D-239 · Three of these were the same defect: a probe answering a weaker question than it appeared to
**Status:** Active

D-229, D-230 and D-231 look like three unrelated health-check bugs. They are one bug three times, and naming the shape is worth more than the three fixes.

Each was a probe that answered a **weaker question than the one it appeared to answer**, and in every case the weaker question's answer was "yes":

| appeared to ask | actually asked | wrong answer it gave |
|---|---|---|
| is the schema current? | has *anything* ever been migrated? | ready, with four modules' tables missing |
| can this replica serve traffic? | can it reach Postgres? | ready, with rate limiting disabled |
| what failed? | *(answered honestly — to the wrong audience)* | the database host, port and username |

**A probe that returns 200 is trusted absolutely, by machinery that cannot argue with it.** That is what makes a weak readiness check more dangerous than no readiness check at all: the load balancer does not merely fail to protect, it actively routes traffic *into* the broken replica on the strength of the answer.

The rule this wave adds: **state what a probe proves, and make the assertion the same shape as the claim.** `evaluateMigrationState` compares sets because the claim is about a set. `createCacheProbe` performs a real round trip because the claim is that a round trip works. Both are pure or injected, so the claim can be tested rather than reasoned about.

### D-240 · Every fix here was mutation-proven, and one repair was rejected for failing that bar
**Status:** Active — reinforces D-214

D-214's standing rule: *a guard is not considered enforced until a mutation of it has been shown to turn a named test red.* All eight defects were verified that way, and the named test is recorded in each entry above.

The bar caught one repair on the way in. The first version of `trust-proxy.test.ts`'s hop-count case sent a **single-entry** `X-Forwarded-For`, asserted the derived address did not move, and failed — correctly. A proxy does not replace that header, it **appends** the address it received the connection from, so a server behind one never sees a single-entry chain. The test had been measuring Fastify answering a different question than the one the deployment asks, and a version of it that passed would have "proved" the hop-count configuration against a topology that does not exist.

The rewritten case simulates the proxy's append and asserts on the real chain. **A test whose fixture does not match production proves something about the fixture** — the same lesson D-225 drew from the mail fake, arrived at from the opposite direction: there the fake was too kind, here it simply was not the thing being modelled.

---

## Wave: notify / parent / billing / foxy module correctness (D-257 – D-265)

### D-257 · `foxy`'s plan reader was a stand-in, so every paying customer got the free tier
**Status:** Active

`app/routes.ts` wired `foxy`'s `readPlan` to `() => Promise.resolve(null)` under a
comment reading *"billing is build step 13"*. Build step 13 shipped; the line did
not change. Every plan-gated decision in `foxy` therefore resolved to `free`
**forever**, and somebody who paid received the 20-message daily cap.

Nothing failed, nothing logged, and no test noticed — **the stand-in was a
perfectly valid `PlanReader`.** That is the whole shape of this defect: a
placeholder that satisfies its type is indistinguishable, to every mechanical
check the project has, from the real thing.

**The obstacle was a recorded-but-unresolved signature mismatch.** `foxy`'s
`PlanReader` was `(studentUserId) => Promise<FoxyPlan | null>` — no actor — while
`billing.getEntitlements(actor, subjectUserId)` requires one and runs
`authoriseSubscription` on it. Two honest resolutions existed:

1. give `PlanReader` an actor; or
2. mint a **system actor** at the composition root, narrow and named.

**(1) wins, because it needs no new authority to exist.** `foxy` only ever asks
about the plan of the student making the request — both call sites pass
`actor.userId` — so the caller *is* the subject, billing's ownership rule is
satisfied by a real principal, and nothing in the product gains the ability to
read a third party's billing. A system actor would have been a new principal that
can read **anybody's** entitlements, created to answer a question that never
asked for it, and kept narrow by discipline forever afterwards.

**It asks about a CAPABILITY, never a plan name.**
`hasFeature(entitlements, 'foxy.unlimited')` and not
`planCode === 'monthly'`. A plan is a commercial artefact — renamed, split,
retired — and a call site switching on its name is a call site nobody edits when
the catalogue changes. Expiry needs no code at all: `resolveEntitlements` decides
"expired" against the injected clock rather than the stored status, so a lapsed
customer drops to the free cap on their very next turn.

`readPlan` is also now **required** on `FoxyModuleDeps`, so a construction site
that has not answered the plan question fails to compile rather than silently
inheriting the cheapest tier.

**Mutation-proven twice, because the defect has two halves and the obvious test
only covers one.**

- Reverting the mapping to `planCode === 'monthly'` turns
  `foxy-plan-reader.test.ts` › *follows the CAPABILITY, so a plan code it has
  never heard of still counts* red (2 failed / 7).
- Restoring `readPlan: () => Promise.resolve(null)` in `app/routes.ts` leaves that
  file **entirely green** — the translator is simply never called. That gap is why
  `app/__tests__/foxy-billing-edge.test.ts` exists: it intercepts
  `createFoxyModule`, captures the `readPlan` the composition root actually
  passes, drives it, and asserts it reached billing. The same mutation turns all
  **5/5** of its cases red. **Testing a translator does not test its binding.**

### D-258 · The public payment webhook had no rate limit, so forged signatures grew an append-only table
**Status:** Active

`POST /api/v1/webhooks/billing` is the only endpoint in the product that is
unauthenticated by design, exempt from the CSRF origin check, and reachable by
anyone on the internet. It had **no rate limit of any kind**, and every delivery
whose signature failed wrote a durable `audit_log` row — so an anonymous caller
chose the growth rate of an append-only table.

The global authenticated throttle in `app/server.ts` cannot cover it: that hook
returns immediately for a request carrying no actor, and **a webhook carries none
by definition.** The audit row exists to report probing; at volume it *becomes*
the payload.

**The key is a constant.** Not the client IP, not `x-razorpay-event-id`, not
anything else in the request — every one of those is chosen by the caller, so
limiting on them limits nobody: an attacker rotates the value and gets a fresh
budget, while the one caller who cannot rotate anything is the genuine provider
behind a stable egress address.

**The budget is spent only by REJECTED deliveries, after the signature check.**
A single endpoint-wide budget has a nasty edge — an attacker's traffic exhausts
what Razorpay's bursty retries need, and the visible symptom is subscriptions
that never activate. Charging only the failing branch removes it: a verified
delivery never touches the limiter and can never be throttled.

Exceeding the budget suppresses **the audit write and nothing else**. The response
is byte-identical either way (a different answer under load tells an attacker they
found the threshold), and the `warn` line still fires — a log line is bounded by
the log pipeline where an append-only table is not, and *"we stopped auditing
because we are being flooded"* is itself what an operator needs to see. 30/minute
is far above any plausible rate of genuine signature failure and far below a
capacity problem; the first rejection in a window is always audited, so a single
probe is never invisible.

`rateLimiter` is **required** on `BillingServiceDeps` and `BillingModuleDeps`. An
optional limiter with a permissive default would restore the defect silently.

**Mutation-proven:** replacing `if (await rejectionBudgetAvailable())` with
`if (true)` turns `webhook-rejection-budget.test.ts` red — 4 failed / 7,
including *STOPS WRITING AUDIT ROWS once the budget is spent* (30 expected, 70
observed) and *spends the budget on a CONSTANT key, not one the caller controls*.
The repository in that suite is a **landmine** — every method throws — so "a
rejected webhook does no database work" is a property the file would fail on
rather than a claim in a comment.

### D-259 · The notification cursor named fewer columns than the sort, and skipped rows
**Status:** Active

`NotifyRepository.list` has always ordered by `(created_at desc, id desc)`. Its
cursor was `created_at` alone, applied as `created_at < :before`.

**A cursor over one column against a sort over two does not name a row.** It names
an *instant*, and every row sharing that instant falls on the excluded side of
`<`. So a page ending on one of two same-instant notifications asked next for rows
strictly older than that instant — and the twin, which sorts immediately after and
was never returned, appeared on **neither page**. Skipped permanently, with a
perfectly ordinary-looking page either side of it.

**Ties are the normal case here, not a corner of it.** `created_at` defaults to
`now()`, which does not advance inside a transaction; a bulk send writes a batch
that way; and every test in the suite runs on an injected clock that returns one
instant until moved. The reason this survived is that the existing pagination
tests happened to page lists whose rows had distinct timestamps.

The predicate is now the **row-value form**,
`(created_at, id) < (:ts::timestamptz, :id::uuid)` — one comparison Postgres
evaluates lexicographically and can drive a composite btree with. The
hand-expanded `or` equivalent means the same thing only while all three
predicates stay in step, and getting one wrong is this defect again. The casts are
explicit because a row-value comparison gives the planner no column to infer a
parameter type from, and an untyped parameter is `text` — which would order rows
by their printed form.

**Both halves or neither, enforced as a 400.** The wire carries `before` +
`beforeId` and `nextBefore` + `nextBeforeId`, with a zod refinement refusing a
half-supplied cursor. Accepting `before` alone would mean any un-updated client
kept asking the exact question that skipped rows — silently, forever. (An opaque
single token was considered and rejected: it cannot be half-supplied at all, but
an operator reading an access log can read an ISO timestamp and a uuid and cannot
read a token, and the refinement buys the same guarantee at the boundary.)
Internally the service returns one `ListCursor`, so a half-cursor is
unrepresentable between the repository and the routes layer.

**Mutation-proven:** reverting the predicate to
`created_at < :before` turns `notify.pagination.test.ts` red — 2 failed / 6:
*RETURNS BOTH ROWS when a page boundary lands between two identical timestamps*
and *returns EVERY row across pages when every timestamp in the list is
identical*. Both assert on the **set of ids** collected across pages rather than
on page sizes, because a count comparison passes while returning the wrong rows.

### D-260 · Notification preferences lived only in a cache, and eviction silently restored the defaults
**Status:** CLOSED by D-268 — the reported migration was written and applied, and the two-line wiring in `app/routes.ts` landed with it. Narrows D-012 / D-033.

Preferences were held in `platform/cache` and nowhere else, justified on record by
*"a lost preference makes the product QUIETER, never louder"*. **Both halves of
that are wrong.** `maxmemory-policy allkeys-lru` is configured, so eviction is
ordinary operation rather than an incident; and the default is **no opt-outs**, so
reverting to it is the *louder* outcome. Somebody who muted email starts receiving
email again, having changed nothing and been told nothing.

**This narrows the standing rule.** D-012/D-033 say *"nothing whose loss changes
what a user is ALLOWED to do may live in a cache"*, and an opt-out passed that
test because an opt-out is not an authorisation. The rule was too narrow: **what a
user has DECIDED belongs beside what a user is ALLOWED.** Neither can be recomputed
from anything else we hold, and losing either is losing something they gave us.

`createDbPreferencesStore` (`notify.preferences.repository.ts`) and
`createWriteThroughPreferencesStore` are both **finished and deliberately
unwired**: the table does not exist. The order of the two writes is the design —
the durable write happens first and its failure propagates; the cache write
happens second and its failure is swallowed. Reversed, a cache that accepted a
value the database refused would serve it until eviction and the old one forever
after, which is the least diagnosable shape this bug has. A cache **miss is not an
answer** and absence is never negatively cached: only a durable `null` means
"never chosen".

It is **latent rather than live** only because there is no service-level write
path yet, which is what made it possible to fix properly instead of quickly.

**MIGRATION REQUIRED — reported, not written** (`drizzle/` is owned by another
change in flight):

```sql
CREATE TABLE "notification_preferences" (
  "user_id"     uuid PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
  "preferences" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "updated_at"  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "notification_preferences_object_check"
    CHECK (jsonb_typeof("preferences") = 'object')
);
```

plus the matching drizzle table object in `src/platform/db/schema/notifications.ts`.
Wiring is then two lines in `app/routes.ts`. **A second index is also wanted for
D-259:** `notifications_recipient_created_idx` is
`(recipient_user_id, created_at desc)` and the composite cursor sorts by
`(created_at desc, id desc)`, so it should become
`(recipient_user_id, created_at desc, id desc)`. Correctness does not depend on
it; the plan does.

**Mutation-proven:** making the write-through `read` treat a cache miss as the
answer turns `preferences-persistence.test.ts` red — 5 failed / 9, including
*STILL RETURNS THE OPT-OUT after the cache entry is gone*. The first case in that
file asserts the **defect itself** against the old cache-only store, so
"fixing the cache" instead of persisting fails loudly and says why.

### D-261 · The weekly-digest unique constraint was verified in the schema, not merely in a passing test
**Status:** Active — completes D-211

D-211 added a behavioural test: two repository-level generations for the same
(parent, child, week) leave one row, unchanged. That asserts an **outcome**, and an
outcome has more than one possible cause — an application pre-check that answers
first, an `ON CONFLICT` naming an index that does not exist and therefore never
fires, or the constraint genuinely working. It cannot tell them apart, yet
D-211's whole claim is that the constraint is *"the only thing that can settle"* a
concurrent pair.

**Verdict: the constraint is real.** `weekly_digests_week_key`, UNIQUE over
`(parent_user_id, student_user_id, week_start)`, declared at
`src/platform/db/schema/parent.ts:99` and emitted by
`drizzle/migrations/0003_parent.sql:54`. Nothing needed fixing. What was missing
was anything that would **notice if it were dropped** — and the schema and the
tests have diverged here before (D-046, D-075: a harness naming its own migrations
ran a whole suite against a schema missing a table and stayed green).

`digest-idempotence-constraint.test.ts` now asks Postgres directly. It asserts the
**column list**, not just the name: a constraint keeping its name and losing
`student_user_id` would give a parent with two children one digest a week — a
silent under-delivery rather than an error. A second case proves the constraint is
**enforced** and not merely declared, by inserting a duplicate into a
`LIKE weekly_digests INCLUDING ALL` temp table (which carries constraints across
but not foreign keys, so the test cannot fail for reasons unrelated to
uniqueness) and asserting SQLSTATE `23505`.

**Mutation-proven:** changing `INCLUDING ALL` to `INCLUDING DEFAULTS` turns
*REFUSES a duplicate row at the database* red — proving the **UNIQUE constraint**,
rather than anything else about the table, is what rejects the second insert.

**Adjacent gap, reported not fixed:** notify's *other* digest idempotence —
`hasDigestFor` over `notifications` where `kind = 'digest_ready'` and
`data->>'weekStart'` matches — has **no database-level uniqueness at all**. It
rests on the job idempotency key plus an application pre-check, which is exactly
the combination D-211 found insufficient. Closing it needs a partial unique index,
i.e. a migration.

### D-262 · `foxy` stream timeouts release the concurrency slot without cancelling the vendor call — NOT FIXED, ownership blocked
**Status:** CLOSED by D-271 — the three-file patch below was applied verbatim.
The rest of this entry is preserved as the diagnosis; see D-271 for what shipped,
including the one thing this entry did not anticipate (abort BEFORE release, so
the freed slot is never handed to a waiting caller while the work it accounted
for is still open).

`createGuardedLlm` enforces the §4 streaming budget with
`withTimeout(guard.name, remaining, () => iterator.next())` and releases the
bulkhead slot in a `finally`. **Neither the timeout nor the release cancels the
underlying work.** `withTimeout` already constructs an `AbortController` and hands
its signal to the operation (`port-guard.ts:90`), and `guarded-llm.ts` **ignores
it**; `anthropic-llm.ts` calls `doFetch` with no `signal`. So on expiry:

- the vendor keeps streaming and keeps billing;
- the socket and its `ReadableStream` reader linger until GC;
- **real concurrency exceeds the configured limit invisibly** — the slot is free
  while the work is not.

The same holds when the student disconnects mid-turn: `foxy`'s `for await` and
`guarded-llm`'s generator are both finalised correctly, but neither calls
`.return()` on the adapter's iterator, so the fetch body stays open.

**This is entirely inside `src/platform/llm/`, which this change does not own.**
It is reported rather than half-done, because a partial fix in `foxy` would look
like a fix and cancel nothing. The required change is three files and additive:

1. `llm.port.ts` — `LlmRequest` gains `readonly signal?: AbortSignal`.
2. `guarded-llm.ts` — one `AbortController` per stream; pass `signal` into
   `inner.stream({ ...req, signal })`; `controller.abort()` in the `finally` and on
   the total-budget `return`, so the release and the cancellation are the same
   event.
3. `anthropic-llm.ts` — forward `signal: req.signal` to `doFetch`.

The test to write with it: a scripted adapter that records whether its signal
aborted, driven past `streaming.totalMs` on the injected clock, asserting the
abort fired **before** the slot was released.

### D-263 · `requireActor` existed in eight copies; the four in scope are now one
**Status:** Active

`notify`, `parent`, `billing` and `foxy` each carried a byte-identical fourteen-line
`requireActor`, differing only in the module name inside the error string.
`content`, `learner` and `practice` carry three more, and `identity.plugin.ts`
exports an eighth. **The four in scope now bind one implementation**
(`src/shared/http/require-actor.ts`); the other four belong to changes in flight
and are reported.

**Why `shared/` rather than identity's exported copy.** `identity.plugin.ts`
already exports exactly this function, and importing it would add four
cross-module edges. Foundation 1 — *every cross-module dependency is injected, not
imported* — is what keeps `app/routes.ts` the complete dependency graph;
deduplicating by adding hidden edges to that graph costs more than the duplication
does. `shared/` is the one place all four may import from that is not a module,
and this function reads one property and throws.

The risk being closed is not the duplication itself but **divergence**: four copies
can drift, and the plausible direction is *"return `undefined` instead of throwing,
because a 500 looked unfriendly"* — which converts a wiring defect into an
unauthenticated read that nothing reports. The local wrappers and per-module actor
types are kept, so each module still states its own actor type at its own boundary.

**Mutation-proven:** replacing the body with an unconditional throw turns
13 tests red across `require-actor.test.ts` and `notify.routes.test.ts`,
confirming the shared implementation is genuinely bound into the route layer
rather than merely present.

### D-264 · Email verification mutates security state on GET — reported, and it is identity's route
**Status:** Open — requires `src/modules/identity/**`

`GET /api/v1/auth/verify` (`identity.routes.ts:131`) consumes a single-use token
and marks an account verified. **A GET is safe to prefetch**, and corporate mail
scanners, link expanders and browser prefetchers issue them unbidden — so the
verification link can be spent before the user clicks it, and the user then sees
"this link has expired" on the one path that must never break (P15 / §8.1).

It is a **known trade-off, not an oversight**: the alternative to a top-level GET
redirect is an interstitial page that POSTs, which adds a step to the funnel with
the highest abandonment cost in the product.

The instruction was *document it explicitly in the route, or add a confirmation
interstitial — do not silently leave it.* **The route is `identity`'s and this
change does not own it**, so the requirement is recorded here instead. Whoever
owns identity should take one of:

1. a block comment at the route stating the prefetch exposure, the funnel
   reasoning, and what would change the decision; **or**
2. an interstitial: GET renders "confirm your email", the POST consumes the token
   (`Cache-Control: no-store` either way).

Option 1 is sufficient if — and only if — it is written down. An undocumented
trade-off is indistinguishable from a defect, and the next person to find it will
either "fix" it and damage the funnel or assume it was considered when it was not.

### D-265 · Dead exports and stale migration numbers, measured rather than assumed
**Status:** Active

**Six unused exports in `src/shared/constants/`, not four.** Measured across
`src/`, `tests/`, `eval/` and `scripts/`, excluding their own definition files:
`PILOT_GRADES`, `isFoxyMode`, `isFoxyAction`, `XP_SOURCES`, `isPlatformRole`,
`isSignupRole`. All six are referenced by **nothing**. `shared/constants` is
imported by every module, so deletion is reported rather than taken here.
Note the shape before deleting: `isFoxyMode`/`isFoxyAction` are the type guards
for constants that *are* used, and `isPlatformRole`/`isSignupRole` likewise — a
guard with no call site usually means a validation boundary that casts instead,
which is worth checking before removing the guard rather than after.

**Stale migration comments: none in the files this change owns.** The chain is now
`0000`-`0005` with the previous one under `drizzle/_superseded`, and `0003`-`0008`
citations across `src/` were expected to be stale. Checking each:

- `foxy.repository.ts:102` and `foxy.service.ts:298` — "a CHECK in migration 0005".
  **Correct.** Current `0005_foxy.sql` genuinely carries
  `chat_messages_abstention_no_citations_check`.
- `parent.repository.ts:390` — already reads *"migration 0003 of the superseded
  chain"*, which is accurate and explicit.

**Stale, and in files owned elsewhere — reported:** `platform/authz/can-access.ts`
(lines 59, 87, 163, 201, 222, 287 — "migrations 0004 and 0005", "migration 0008"),
`identity/identity.repository.ts:77` and `identity.types.ts:15` ("NOT NULL since
migration 0008" — the chain now stops at 0005), `platform/db/schema/tenants.ts:27`,
`platform/db/schema/practice.ts:249` ("COMMENT ON COLUMN in migration 0006"),
`platform/db/schema/identity.ts:19`, `platform/config/config.schema.ts:305`,
`content/content.repository.ts:98`, `content/content.types.ts:43`, and the
`can-access` / `content` / `identity` test files that repeat them.

The actively misleading ones are the **`0008` citations**: an operator reading
`identity.types.ts:15` and looking for migration 0008 finds a chain that ends at
0005 and a `_superseded/` directory, and cannot tell whether the column is NOT NULL
today. The `0004`/`0005` ones are worse in a quieter way — those numbers **exist in
the current chain and mean something else** (`0004` is billing, `0005` is foxy), so
they read as correct and are not.

### D-266 · `Retry-After` advertised the full window, so obeying the header was the punishment
**Status:** Active — completes D-034

`RateLimiter.consume` threw `new RateLimitError(rule.windowSeconds)` on every
refusal, regardless of how much of the window had elapsed. Trip the login limiter
fourteen minutes and fifty seconds into its fifteen-minute window and the client
was told to wait **fifteen minutes** for a lockout with ten seconds left on it.

**`Retry-After` is obeyed, which is what makes this a defect rather than a
cosmetic inaccuracy.** A mobile client, a retrying SDK and our own frontend all
wait exactly as long as they are told. So the honest ten seconds became fifteen
minutes for every well-behaved caller, and **only a caller that IGNORED the
header discovered it could have retried**. The limiter penalised correct
behaviour and rewarded ignoring it.

**Nothing caught it because the underlying limit was correct throughout.**
`countInCache` calls `expire` exactly once, on attempt 1, precisely so a lockout
cannot creep forward — so the window genuinely never extends and only the
ADVERTISED wait was wrong. No error, no metric, no failing test. The user-visible
report is "it locks me out for ages" against a rule that reads 5-per-15-minutes
and is accurate.

`WindowDeadlines` already knew the answer: it records each window's deadline so
an evicted counter can be told from an expired one. `remainingSeconds(key,
windowSeconds)` reads it, rounds **up** (a `Retry-After: 0` invites an immediate
refusal; rounding 1.2s down to 1s puts the client back 200ms early, which is a
retry loop that looks like an attack), and falls back to the full window when
this process never saw the window open — another replica, or before a restart.
That fallback is deliberate and conservative: guessing "nearly over" there sends
a caller straight back into a refusal, so over-reporting is the safe direction.

**Mutation-proven:** restoring `new RateLimitError(rule.windowSeconds, …)` turns
`platform/rate-limit/__tests__/retry-after.test.ts` red — 3 of 6, including
*reports the remaining seconds, not the whole window*.

**The same entry covers the inbound `x-request-id` cap**
(`app/plugins/request-id.ts`), which was accepted **verbatim and unbounded**,
bound into the child logger for the request, and echoed on the response. Three
consequences, none of which failed anything: an 8 kB header (inside Fastify's
limit) multiplied by every line a request logs is a **log-volume lever the caller
chooses**; a newline breaks line-oriented log shipping and a forged
`"level":"error"` fragment is read by whatever parses the stream; and the value
comes straight back in a response header.

The rule is a **character allowlist plus a 200-character cap**, not a length
alone — a denylist of "characters that break log shipping" is a list somebody has
to keep complete. 200 is comfortably above a UUID (36), a W3C `traceparent` (55)
and the longest convention in common use (~128). **A rejected id is REPLACED,
never refused:** a 400 would let a broken upstream proxy take the API down over a
correlation identifier.

**One finding was worse than reported.** The mutation test showed the CR/LF cases
do not merely pollute the log — they make the response **hang for 15 seconds** and
time out, because the value is echoed into a response header. It was an
availability defect as well as a log-injection one.

### D-267 · `JobRow.run_at` and `created_at` were typed `Date` and the driver returns strings
**Status:** Active — completes D-233

D-233 typed `locked_at` as `Date | string` and explicitly left the other two
alone, reasoning that they "have never been PROVEN to be one, because nothing
ever called a method on them — they are handed straight out and only ever
compared". **That is an explanation of why it had not blown up yet, not an
argument that it was safe**, and the lie was not confined to the file: they are
handed out as `ClaimedJob.runAt` / `.createdAt`, both declared `Date`, so it was
exported.

`locked_at` was found the hard way — the integration suite threw
`job.lockedAt.toISOString is not a function` on its first run, because the fence
formats it back into SQL. The first caller to write `job.runAt.getTime()` for a
scheduler, a lateness metric or a log line would have got the same `TypeError` in
a worker, past a compiler that had already signed off on it.

**This was live, not latent.** The mutation test reads
`expected '2026-08-09 08:00:00+00' to be an instance of Date` — node-postgres
returns a **string** for these columns through `db.execute`, today, in this
schema. The annotation was simply false.

Both are now `Date | string` in `JobRow` and normalised once through a `toDate`
helper in `toRecord`, which `locked_at` now shares. "Fix the types, or parse
them" — both: the honesty stops at the row boundary and every consumer still gets
a real `Date`.

**Mutation-proven:** replacing `toDate(row.run_at)` with `row.run_at as Date`
turns `tests/integration/job-queue.test.ts` red on *hands out real Date objects
for runAt, createdAt AND lockedAt*. Only an integration test can catch it: a unit
test with a fake row supplies whatever type it declares.

### D-268 · `notification_preferences` exists, and the notification index finally matches its cursor
**Status:** Active — closes D-260, completes D-259

Migration `0006_notify_preferences`. `createDbPreferencesStore` and
`createWriteThroughPreferencesStore` had been **finished and deliberately
unwired** since D-260 for exactly one reason: the table did not exist. It does
now, with the shape D-260 specified — `user_id` uuid primary key referencing
`users` on delete cascade, `preferences` jsonb not null default `'{}'`,
`updated_at` timestamptz, and `CHECK (jsonb_typeof(preferences) = 'object')`.

**The CHECK is load-bearing, not decoration.** jsonb accepts `'"muted"'`,
`'null'`, `'[]'` and `'3'` as perfectly valid documents, and every one would
reach `parseStoredPreferences` as a shape it must defend against forever. It is
the third instance of the same constraint in this schema
(`notifications_data_object_check`, `audit_log.metadata`).

**No surrogate key.** The user IS the key. A surrogate id would permit two
preference rows for one user, which is not a resolvable state — whichever you
read, the other is also something they said.

`notifications_recipient_created_idx` widened from `(recipient_user_id,
created_at desc)` to `(recipient_user_id, created_at desc, id desc)`, matching the
composite cursor. D-259 fixed the cursor, so **correctness** no longer depends on
this and **performance** does: with two columns Postgres satisfies the first two
sort keys from the index and then sorts each equal-timestamp group by `id`
itself. Drop-then-create rather than a second index, and in that order — a
leftover two-column index on the same leading columns would be chosen by the
planner about as often as the three-column one and the change would appear to
have done nothing.

The wiring is the two lines in `app/routes.ts` D-260 promised, and the write
order is the design: durable first with its failure propagating, cache second
with its failure swallowed. Reversed, a cache holding a value the database
refused would serve it until eviction and the old one forever after.

**Mutation-proven twice.** Removing the `preferences:` block from
`app/routes.ts` turns *honours an opt-out that exists ONLY in the database* red —
email is scheduled for a user who muted it. Weakening the migration's CHECK to
`CHECK (true)` turns all four *REFUSES … in the preferences column* cases red.

### D-269 · The migration journal ordering defect tried to ship again, and the guard caught it
**Status:** Active — D-109 / D-174 enforcement, working

`drizzle-kit generate` wrote `0006_notify_preferences` with
`"when": 1786434818902`. Every hand-written entry from `0001` onward uses round
numbers, and `0005_foxy` sits at `1786800000000` — so the generated wall-clock
value landed **370 million milliseconds BELOW its own predecessor**.

`drizzle-orm`'s migrator does not use `idx`. It reads the last row of
`drizzle.__drizzle_migrations`, takes its `created_at`, and applies only entries
whose `when` is greater. On any database already past `0005`, this migration
would have been **skipped in silence** — "Migrations applied." printed,
`notification_preferences` never created, and the newly-wired durable preferences
store failing on the first notification. That is exactly the shape `0004_billing`
shipped in, and exactly what D-174 warned would happen again.

Corrected to `1786850000000`. **The value is now a deliberate choice and not a
wall-clock artefact**, which is the property that matters: `drizzle-kit` derives
it from the clock, this chain's values are hand-assigned, and the two conventions
cannot both be right.

**Mutation-proven:** restoring drizzle-kit's generated `when` turns
`tests/integration/migration-journal-order.test.ts` red — 2 of 8, naming
`0006_notify_preferences` as the entry that would go unapplied. Worth recording
that the guard fired on its first real opportunity since it was written.

### D-270 · `TimeoutRule.retries` is wired, and the reason it could not simply be applied
**Status:** Active — closes D-237

The §4 timeout table has carried a `retries` column since the plan was written.
It was parsed, range-validated, documented ("a non-zero value here is a statement
that the call is idempotent") and **read by nothing**. That is worse than not
having the column: `payments: { retries: 0 }` sits beside the sentence "none on
writes — retrying a payment is worse than failing it", and a reader takes it as an
enforced safety property. It forbade exactly as much as `mail: { retries: 3 }`
required — nothing. **An unwired safety setting is a false guarantee, and the cost
is paid by the next person who trusts it.**

**Why it could not be applied blanket, which is why it sat unwired rather than
being an oversight.** A guard wraps a **port**, not an operation, and the port's
rule cannot know which operation it is:

- `cache` carries `retries: 1`, and `cache.incr` is the rate limiter's counter. A
  timed-out `INCR` has very often been executed; retrying it **double-counts a
  login attempt** and locks a user out having done nothing wrong — a retry budget
  silently TIGHTENING an authentication limit, reported as "random lockouts".
- `mail` carries the largest budget in the table, `retries: 3`, and `mail.send` is
  not idempotent. A timed-out SMTP send has often been delivered. Blanket wiring
  would send a **password-reset link up to four times**, from a change whose
  stated purpose was reliability.

So the **rule supplies the budget and the call site supplies the permission**, via
`GuardedCallOptions.idempotent`, and a retry needs both. Absent — the default, and
every call site written before this — means one attempt, so nothing that already
exists can start retrying. `payments: 0` is now load-bearing in the direction it
always claimed: **the permission cannot exceed the policy**, so even a call site
that declares itself repeatable gets one attempt.

Declared repeatable: `embed.embedQuery` (pure, writes nothing), `cache.get`,
`cache.set`, `cache.del`, `cache.expire`. Deliberately not: `cache.incr`,
`mail.send`, and both payment writes. Each omission carries its reason at the call
site rather than in a plan.

**Composition order.** The limiter is OUTSIDE the retry loop — one slot for the
whole retried operation, because re-acquiring per attempt would let real in-flight
concurrency exceed the configured limit while the limiter's count reported the
configured number, which is the same class of defect as D-262 and not worth
introducing a second time while fixing the first. The breaker is INSIDE it: each
attempt is a real call and §5 counts failed calls, and an open breaker then
short-circuits the retry for free. `isWorthRetrying` declines breaker rejections
(retrying one turns the breaker into a slow retry loop against something known to
be broken) and concurrency rejections (backing off inside a held slot adds load to
an overloaded port), distinguished structurally by the `details` each thrower
stamps rather than by message text.

A fifth emission joins the registry: `platform.port.retried`. A dependency that
succeeds on attempt two every single time is failing every single time, and
without the counter it is indistinguishable from a healthy one.

**Mutation-proven:** forcing `attempts = 1` turns
`src/platform/resilience/__tests__/port-guard-retries.test.ts` red — 8 of 14.

### D-271 · The LLM stream timeout now cancels the vendor call
**Status:** Active — closes D-262

Applied exactly as D-262 specified, in three files. `LlmRequest` gains an optional
`signal`; `createGuardedLlm` builds **one `AbortController` per stream** and aborts
it in the same `finally` that releases the bulkhead slot; `anthropic-llm.ts`
forwards `signal` to `doFetch`.

**The pairing is the fix, not the abort on its own.** Releasing the slot and
stopping the work were two different events with only one of them implemented, so
the limiter's count and the number of live vendor streams drifted apart with
nothing to report it. Making them the same statement means they cannot drift:
every path out of the generator — the total-budget return, the first-token
timeout, an exhausted iterator, a thrown breaker rejection, and the `.return()`
the runtime calls when a student disconnects mid-turn — runs that `finally`.
**Abort before release**, deliberately: the other order re-opens the same
over-admission window, just narrower.

**Not `withTimeout`'s controller.** That one is per-`next()` and fires when a
single token wait expires, which is a different event from "this stream is over" —
aborting the fetch on the first-token deadline would kill a stream the total
budget still allows.

`complete()` needs no equivalent: it goes through `options.http`, which is already
`createHttpClient` behind `guard.run`, and that path receives and forwards
`withTimeout`'s signal.

**Every pre-existing assertion was green while the defect was live**, which is the
point of the new ones. *holds a concurrency slot for the LIFETIME of the stream*
and *releases the slot when a stream is abandoned part-way* both pass whether or
not anything is cancelled, because they only asked the LIMITER what it thought.
The limiter thought the stream was over.

**Mutation-proven:** removing `cancellation.abort()` turns 4 of the new
`guarded-ports` cases red; removing the `signal` argument in the adapter turns
*forwards the caller's AbortSignal to fetch* red.

### D-272 · `parsePlanIds` refuses instead of shrugging
**Status:** Active — closes the open half of D-253

D-253 recorded this as still open: the pre-flight caught a malformed
`RAZORPAY_PLAN_IDS` in a deployed stack, and "the parser should refuse rather than
shrug" for every other caller — a test, a script, a future process.

`RAZORPAY_PLAN_IDS=monthly=plan_x` — an `=` where a `:` belongs, one keystroke —
parsed to `{}`. A value the type system is perfectly happy with, that boots, that
reports healthy on every probe, and that fails at the checkout of the first
customer who tries to give us money. **The variable was set, the deployment was
green, and the paid funnel was dead.**

`container.ts` argues correctly that an empty plan map is not one of its boot
refusals because it is a LOUD failure where a missing credential is a SILENT
fallback. The gap is **who** it is loud to. `{}` is loud to a paying customer.

Four refusals, each **naming the offending entry**, because "the plan ids are
malformed" sends an operator to re-read a variable they have already read twice:
no `:` separator (or more than one), an empty code or plan id, an empty entry (a
stray or trailing comma), and a **duplicated plan code** — the old behaviour let
the later pair win silently, so half the variable was decoration and the value
itself did not show which half.

`undefined` remains `{}` and is not a refusal — "this deployment has no plan map"
is legitimate in every non-production environment, and refusing it would be D-250
rebuilt. An **empty string** is refused: somebody set the variable and gave it
nothing, which is a mistake rather than a state.

Validated in the zod schema via `superRefine` as well as in `toConfig`, so the
refusal joins the aggregated `Invalid environment configuration` report rather
than arriving one restart later.

D-256's `ops:preflight` is not replaced — it also checks the map against
`purchasablePlans()`, which `platform/config` may not import.

**Mutation-proven:** restoring the original drop-and-continue parser turns
`payments-config.test.ts` red — 10 of 15.

### D-273 · `IDENTITY_IP_HASH_SALT` is configuration, not a build constant
**Status:** Active — closes D-223, completes D-221

D-221 salted `hashIp` and could reach neither `platform/config` nor
`app/routes.ts`, so the identity module resolved the salt itself: absent, it
warned and used `UNCONFIGURED_IP_HASH_SALT` — a constant **in the source**,
documented as not secret. `sessions.ip_hash` was therefore pseudonymised against a
generic rainbow table and against nobody who had read the repository, and because
the identical digest is also a rate-limit cache key it joined a Valkey dump to a
Postgres dump exactly.

`IDENTITY_IP_HASH_SALT` is now parsed once in `platform/config` and threaded
through `app/routes.ts` into `createIdentityModule({ ipHashSalt })`. The module
still never touches `process.env`, so the set of variables this process depends on
stays enumerable in one file.

**Three deliberate choices.**

*Optional, not a production boot refusal.* Making it a refusal is correct on the
merits and would **restart-loop every existing deployment on the deploy that
shipped it** — D-250 exactly, a fix that causes the outage. The module's
`identity.ip_hash_salt_unconfigured` warn keeps the gap visible; promoting it to a
refusal is a one-line follow-up in `container.ts` once operators have set it.
compose.prod.yml passes it with a soft `${VAR:-}` and says why in as many words.

*A 32-character minimum.* A short salt is far closer to no salt than to a good one
and would otherwise pass silently while reading as "configured".

*An empty string is treated as absent.* The soft compose default supplies `''` to
a stack that has not set it, and refusing that would be the restart loop above by
another route.

**`?? default` was NOT used at the composition root**, and that is the subtle way
this wiring goes wrong: substituting a value there type-checks, works, and
silences the one signal saying the deployment is still hashing with a constant
from the source. The field is omitted entirely instead.

**Mutation-proven:** removing the threading turns
`src/app/__tests__/ip-hash-salt-wiring.test.ts` red on *is SILENT once the salt is
configured*.

### D-274 · Four wiring tests asserted gate ORDER while claiming to assert gate CONTENT
**Status:** Active

`wiring.test.ts`'s payments block built a `PRODUCTION_BASE` that satisfied **no**
production boot gate, then asserted `toThrow(/RAZORPAY_KEY_ID/)`.
`createContainer` runs its refusals in source order — mail, embed, llm, payments,
migration journal — and every one throws, so the assertion only ever passed
because payments happened to be **first among the unmet gates**.

D-226 added the SMTP gate ahead of payments and all four went red with `SMTP_HOST
is required in production`: a correct refusal, reported as a payments regression.
The tests were measuring ordering.

`PRODUCTION_BASE` now satisfies **every** gate and each case removes exactly the
variable it is about via a `without()` helper. A gate added ahead of payments
tomorrow cannot break this block, because a satisfied gate does not throw and
therefore cannot be the thing observed. One assertion was added that the old shape
could not make: *refuses for the PAYMENTS reason, not because some earlier gate
was unset*.

This is a general lesson about boot-gate tests, not a one-off: **an assertion that
a constructor throws a particular message is an assertion about ordering unless
everything else is satisfied.**

### D-275 · `/health/ready` carries a status and nothing else, and the detail moved to `/health/deps`
**Status:** Active — completes D-229

`tests/integration/health-ready.test.ts` still asserted the `checks: { database,
migrations, config }` map and a `database.error` string that D-229 **deliberately
removed** — they rendered the raw pg error, carrying the host, the port and the
database username, to any unauthenticated caller at the exact moment the database
went down.

The three detail assertions moved to `/health/deps`, which is the endpoint that
exists for that question, and are **strictly sharper there**: `checks: { database:
true, migrations: false }` and `failure: 'schema_incomplete'` say the same thing,
but only the latter separates "unmigrated" from "unreachable" and "timeout" —
three different runbook pages. `failure` is a closed union and therefore cannot
grow a hostname, because it is not a string field.

The readiness assertion is **inverted rather than deleted**: the body is now
pinned as exactly `{ status }`, plus a check that the response contains neither the
hostname, the port nor the username from the connection string the test is itself
using. Re-widening the body is now a failing test rather than a silent regression.

**One leg was NOT recreated, and is reported rather than faked.** `checks.config`
has no home on `/health/deps` and has not been reinvented there. It was vacuous
where it stood: config is parsed by `parseConfig` at boot, and a process whose
config did not parse never binds a socket — so nothing could reach the route to be
told `config: false`. It could only ever report `true`. `/health/deps` reports live
dependency state and config is not a live dependency; the boot gates in
`createContainer` assert it at the only moment the answer can be anything else.

### D-276 · `DATABASE_POOL_MAX` defaults to 40, and the test that pinned 10 was pinning a dead variable
**Status:** Active — follows D-228

`config.test.ts` asserted `config.db.poolMax === 10`. D-228 moved the default to 40
and, more importantly, made the variable **mean something**: it had been parsed and
read by nothing, so the old assertion pinned a number that was applied to no pool.
10 as a live ceiling would throttle `auth` alone, which asks for 10 by itself; 40
is the api role's natural sum, 10 + 20 + 8 + 2.

The per-pool defaults are now asserted alongside it, so "40" cannot stay green
while the four numbers underneath it drift away from summing to it.

**A stale exemption was found in passing.** `env-contract-check.ts` exempted
`DATABASE_POOL_MAX` from the compose contract with the reason "schema default 10;
used only by migrations and scripts, not the app". Both halves expired at D-228.
**An exemption whose justification has expired is worse than no exemption — it is a
reviewer's reason not to look.** `compose.prod.yml` now passes it, with the
cross-replica arithmetic (`api x 40 + worker x 20 + headroom <= max_connections`,
and a rolling deploy briefly doubling the api term) stated where an operator
scaling replicas will read it.

### D-277 · A timing test's noise anchor was under-sized, and it was the only flake in the suite
**Status:** Active

`identity.mail-path.test.ts`'s `ANSWERS A NEW AND AN ALREADY-REGISTERED ADDRESS IN
THE SAME TIME` failed under a **full** `npm test` run and passed every time in
isolation — observed at an anchored ratio of 12.48 against a bound of 10, with both
ABSOLUTE assertions (the ones the file's own header calls load-bearing) green by
two orders of magnitude on the same run.

That is the anchor failing to anchor, not the property failing to hold.
`NOISE_FLOOR_MS` exists to bound the estimator by the resolution of the measurement
rather than by the smaller sample, and at 1 ms it was under-sized for the case it
had to cover: the signup case's own stated residual — two INSERTs against one that
fails on a unique index — is about six milliseconds in a container, so the ratio was
being set by whichever branch happened to be sub-millisecond. That is precisely the
"divides noise by noise" failure the constant was introduced to prevent.

Raised to 5. **Raising a noise floor to stop a flake is one edit away from raising
it until nothing can fail, and the two edits look identical in a diff**, so the
constant now has its own guard: `rejects a defect-sized asymmetry at the floor it is
configured with` exercises `anchoredRatio` directly against the shape the defect
produces (`MAIL_LATENCY_MS` on one branch) and against the residual alone, and both
bounds in the file must still separate them. Pure arithmetic, no clock, no sleep —
it asks whether the instrument can still see the thing, not how fast the machine is
today.

Of the nine failures this wave started with, this was **the only one that was not a
stale test**. It was a pre-existing load-dependent flake, red in the baseline run and
green in isolation.

### D-278 · The five-emission resilience registry
**Status:** Active — bookkeeping for D-270

`ResilienceRegistryOptions.metrics` documented itself as wiring "FOUR emissions at
once, and they are four because that is the list §5 and §3.3 and §4 actually name".
It is five now — breaker transitions, breaker rejections, concurrency rejections,
port timeouts, **port retries** — and the comment says so.

Recorded separately and deliberately. That paragraph is the kind of self-describing
count that goes stale on the next change and then reads as authoritative for a year;
the number is load-bearing to a reader deciding whether their signal is already
wired. The registry also gained `sleeper` and `random` options so that a test
asserting retry BEHAVIOUR can inject a `RecordingSleeper` and read the jittered
sequence back with no wall-clock time passing — §9.5 bans `sleep` in a test, and the
seam is what makes obeying it possible now that a guarded call can wait.

### D-279 · `docker compose config` did not exit 0 before this wave, and it was the local `.env.prod`
**Status:** Active — operational note

`docker compose -f docker/compose.prod.yml config` exited **15** at the start of this
work, on `VOYAGE_API_KEY` and then on `SMTP_HOST`. Nothing in the tracked tree was
wrong: `docker/.env.prod.example` carries every variable, and `compose.prod.yml`'s
`:?` markers are correct. The **untracked, gitignored `docker/.env.prod`** had fallen
behind the example after the D-226/D-254 SMTP wave added five required variables to
it.

Worth recording because of the shape rather than the fix. The env-contract gate
(D-252, D-255) relates `config.schema.ts`, `compose.prod.yml` and both `.env.example`
files, and it passes — **it cannot see the operator's real `.env.prod`, by
construction, because that file holds secrets and is not in the repository.** So "the
contract is green" and "the stack will start" are different claims, and the second one
is only answered by running `compose config` against the actual env file. That command
belongs in the deploy runbook ahead of `deploy-app.sh`, not only in CI.

### D-280 · What this wave did NOT do, listed so it is not mistaken for done
**Status:** Open — residue

Every item below was reachable and was deliberately left, with the reason:

1. **`IDENTITY_IP_HASH_SALT` is not a production boot refusal** (D-273). It should
   become one — `container.ts`, one `if`, alongside the other nine — once operators
   have set it everywhere. Doing it in the same change that introduced the variable
   would restart-loop every running stack (D-250).

2. **`notification_preferences` has no HTTP write path.** D-260 noted the defect was
   "latent rather than live only because there is no service-level write path yet",
   and that is still true: `notify` exposes no preferences endpoint, so the only
   writers are tests and whatever calls the store directly. The table and the store
   are correct and largely unexercised in production until an endpoint exists.

3. **`mail`'s `retries: 3` budget is declared and unspent** (D-270). No mail operation
   is idempotent, so nothing claims it. The right answer for mail is §3.3's overflow
   behaviour — defer to the worker, whose queue already has at-least-once semantics —
   and a retry here would be a second, worse delivery mechanism competing with the good
   one. The budget remains as a ceiling if a genuinely repeatable mail operation ever
   exists.

4. **`checks.config` from the old `/health/ready` body was not recreated anywhere**
   (D-275). It was vacuous; the reasoning is in that entry.

5. **The six dead exports in `src/shared/constants/` reported under D-265 are still
   there.** Out of scope for this wave and unchanged.

6. **`retries` is declared repeatable at five call sites only.** `platform/http`'s own
   `maxRetries` and the guard's budget are two retry mechanisms on the same port and
   have not been reconciled; `http` is left un-declared so they cannot multiply. That
   reconciliation is a separate change.

## Identity third-audit remediation — 11 August 2026 (D-291 to D-297)

*Three confirmed defects in `src/modules/identity/`, plus what fixing them forced into
the open. Every fix below was mutation-proven: the defect was re-applied and a NAMED
test was shown to go red, with the result recorded on the entry. Two of the three
defects share a shape worth naming up front — **a comment that describes a mechanism
nobody built**. D-214 named it, D-217 was an instance of it, and D-291 is D-217's own
comment turning out to be the next instance.*

### D-291 · Signup "completed" into an unusable account, because the recovery path D-217 promised did not exist
**Status:** Active

D-217 took the verification email off the signup request path so that a provider
outage could not 500 a signup whose user row was already committed. That was correct
and it stays. Its justification, quoted verbatim from `identity.service.ts`, was not:

> the RECOVERY PATH ALREADY EXISTS AND DOES NOT DEPEND ON IT — the verification and
> reset tokens are committed rows, so **a resend re-mails the token that is already
> persisted**. Losing a send costs one email, never an account.

**There was no resend.** The module had seven `/auth/*` routes — `signup`, `verify`,
`login`, `logout`, `logout-all`, `forgot-password`, `reset-password` — and not one of
them re-mailed anything. An auditor confirmed it against a real server with mail down:

```
MAIL-DOWN signup:  201 {"status":"ok","message":"Check your email…"}
MAIL-DOWN user row created: { n: 1 }
MAIL-DOWN queued jobs: []
```

So the account survived the outage exactly as designed and was **useless**: the
address was taken, so the user could not sign up again; the verification link was
gone, so they could not verify the account they had; and there was nothing to ask.
"Losing a send costs one email, never an account" was true only if the sentence before
it was, and it was not. This is the D-214 pattern with a twist that is worth stating
plainly: **the comment was not describing missing code in the same file, it was
describing a missing ENDPOINT**, which is why reading `identity.service.ts` closely
would never have found it. Only counting the routes does.

`POST /api/v1/auth/resend-verification` now exists, shaped deliberately like
`forgot-password` rather than invented fresh:

- **Enumeration-safe across THREE branches, not two.** Unknown address,
  awaiting-verification address and **already-verified** address all return a
  byte-identical `200 {"status":"ok"}`. The third branch is the one specific to this
  endpoint, and a distinct answer for it would leak a second bit beyond existence —
  whether the account is verified.
- **Timing-symmetric**, by D-218's construction rather than by hope: both rate-limit
  counters are consumed before any lookup, the token is generated **before** the
  existence branch on all three paths (one `randomBytes` and one SHA-256 either way,
  the same trick as login's dummy Argon2 verification), and the send is deferred, so
  it contributes to no branch's latency. What remains on the mailing branch is one
  small transaction — the same residual `requestPasswordReset` already carries.
- **Rate limited** on `TOKEN_ENDPOINT_RATE_LIMIT`, by IP and by address (D-295).
- **A verified account is sent nothing and mints no token.** A resend that mailed a
  live verification link to an address whose owner did not ask for one is a session
  waiting to be handed to whoever reads that mailbox next.

**Mutation proof:** deleting the route registration from `identity.routes.ts` turns
**7** named tests red in `identity.routes.test.ts`, headed by `EXISTS. Before this it
was a 404, and D-217 depended on it` and `completes the journey: signup, resend,
verify, log in`. Two of those seven only went red after being strengthened during this
wave — see D-296.

Separately, replacing `deferMail(...)` with `await mail.send(...)` at the resend call
site — the D-218 defect re-applied to the new endpoint — turns `RESEND ANSWERS AN
UNVERIFIED AND AN UNKNOWN ADDRESS IN THE SAME TIME` and `SURVIVES THE OUTAGE ITSELF: a
failing resend still persists its token` red.

### D-292 · Three rate limits could be inflated a hundredfold with every test green
**Status:** Active

An auditor changed `SIGNUP` 3 → 300, `LOGOUT` 30 → 3000 and `TOKEN_ENDPOINT` 10 → 1000
per hour, and **all 2,530 tests passed.**

The cause is a shape, not an omission, and it is worth writing down because it reads
as thorough testing right up until something is mutated:

```ts
for (let attempt = 0; attempt < SIGNUP_RATE_LIMIT.limit; attempt += 1) { await signup(); }
await expect(signup()).rejects.toMatchObject({ code: RATE_LIMIT });
```

That loop asserts the limiter is **internally consistent** — whatever number the
constant holds, the next request past it is refused. It cannot observe the number.
Raise the constant to 300 and the loop obligingly runs 300 times and still watches the
301st get refused. Signup at 300/hour per IP is account farming **and** a mail bomb,
since every signup sends a verification email. `TOKEN_ENDPOINT_RATE_LIMIT` — which
guards `verify`, `reset-password` and now the resend, i.e. every endpoint that redeems
or re-mails a credential — **had no test at all**.

The contrast the audit drew is the fix, and it was already in the repository:
`LOGIN`, `LINK_CODE`, `LINK_SUBMIT`, `FORGOT_PASSWORD` and `AUTHENTICATED` all went
**red** under the same mutation, because somewhere a test **names the literal** —
"allows five in an hour and REJECTS the sixth". That style is now extended to the
whole table, in two independent kinds of test so that an inflation has to defeat both:

1. `identity.rate-limit-policy.test.ts` — the §6.9 table transcribed as literals. It
   pins the POLICY and deliberately does not exercise the limiter, because a test that
   did both could be satisfied by changing either.
2. `THE RATE-LIMIT COUNTS, NAMED` in `identity.service.test.ts` — the BEHAVIOUR,
   counted in hardcoded literals ("three signups an hour, the fourth is refused").
   `SIGNUP_RATE_LIMIT` and its siblings are not referenced anywhere in that block, on
   purpose: the test knows the number and the implementation does not get to tell it.

The existing loop-shaped tests are left exactly as they are. They assert a real and
different property — that the limiter is consistent with whatever it is configured
with — and deleting them would trade one blind spot for another.

**Mutation proof:** re-applying all three inflations turns **13** named tests red,
including `SIGNUP is not account farming: 3 an hour per IP, not 300`, `LOGOUT stays a
flood bound on the auth pool: 30 an hour, not 3000`, `TOKEN_ENDPOINT stays a
credential-redemption bound: 10 an hour, not 1000`, and the five behavioural counts.

### D-293 · A false database guarantee on a role narrowing, at the two places that build the Actor
**Status:** Active

`identity.repository.ts` carried this:

```ts
// The column carries a CHECK constraint limiting it to these two values,
// so the database is the guarantee behind this narrowing.
role: row.role as Role,
```

`Role` is `z.enum(['student', 'parent'])` — **two** values. The CHECK is built from
`PLATFORM_ROLES` — **ten** (`0000_baseline.sql:129`, `shared/constants/roles.ts:39-53`)
— because the column was deliberately widened ahead of time so that adding a teacher in
Phase 1 is an INSERT rather than an ACCESS EXCLUSIVE lock and a full validation scan on
a live table. **The cited guarantee was the exact opposite of the truth**, and a comment
that asserts a database invariant is the most expensive kind of wrong: the next reader
stops checking.

The same cast appeared at `findSessionByTokenHash`, which is the sharper site — that
is the lookup on every authenticated request, and its result becomes the request
`Actor` that every authorisation decision is made against.

`platform/authz/can-access.ts` documents this failure mode **by name** and fixed its
own type for it: *"a `teacher` row would arrive as a value the compiler believes is
impossible … a privilege escalation delivered by a type that was merely out of date."*
The repository sits **upstream** of that file and was not fixed with it.

Not exploitable today — nothing grants a non-signup role, and `can-access.ts:300`
denies unknown roles explicitly. The defect is that **it goes silent the day one is
granted**, which is a day nobody will connect to this cast.

Both records are now typed `PlatformRole`, which is what the CHECK actually enforces,
imported from the same constant the migration is generated from so the two cannot
drift. The false comment is deleted and replaced with what the database does
guarantee. `UserRecord.role` and `SessionWithUser.role` follow.

Two guards were added rather than one, because the runtime half alone is not enough —
`'teacher'` is still `'teacher'` at runtime however it is typed, which is exactly why
this was invisible:

- **Runtime**, `identity.role-narrowing.test.ts`: a `teacher` is granted the way Phase
  1 will grant one, straight into the column, and asserted to arrive as itself through
  both `findUserByEmail` and `validateSession`. Every widened role is driven, not just
  the one the file happens to name.
- **Compile-time**, in the same file: `Exclude<UserRecord['role'], Role>` must be
  INHABITED. Narrow the record back to `Role` and it collapses to `never`, and the
  assignment stops compiling.

`identity.types.ts` also now asserts, at compile time, that `PlatformRole` is
assignable to `platform/authz`'s hand-written `ActorRole`. Those are two hand-kept
copies of one vocabulary — `can-access.ts` imports nothing but its error type, by rule
— and two copies of a list is what D-293 is about in the first place.

**Mutation proof:** restoring `role: row.role as Role` and `readonly role: Role`
leaves every runtime test green — as it must, which is the entire lesson — and turns
`npm run type-check` red at `identity.role-narrowing.test.ts(169,11): Type '"teacher"'
is not assignable to type 'never'` inside the named test `types a user record wide
enough to HOLD a non-signup role`.

### D-294 · "Reuse the persisted token if it is still valid" is not implementable, and the honest version is a replacement
**Status:** Active

The brief for D-291 asked the resend to "reuse the persisted token if it is still
valid, or issue a fresh one and consume the old". The first half cannot be done and
the reason is the design working correctly: `email_verification_tokens` stores a
**SHA-256 of the token and never the token** (§6.1), so a surviving row contains
nothing that can be put in an email. Recording it rather than quietly implementing
half of it, because "why didn't you reuse the token" is a reasonable question and the
answer is a property of the schema, not an oversight.

Every resend therefore mints a fresh token, and
`reissueEmailVerificationToken` retires every outstanding unconsumed row for that user
and inserts the new one in **one transaction**. Two consequences, both wanted:

- **One live link at a time.** A resend that merely added a row would leave every
  previously mailed link live, so a token in a forwarded message or a mail archive
  would still verify the account long after the user asked for a new one.
- **Never zero live links.** Splitting the two statements would let a crash leave the
  user with no token and no way to get one — which is precisely the unverifiable
  account this endpoint exists to rescue.

Retiring is `consumed_at = now`, never `DELETE`: the row is the record that a token
was issued.

**Mutation proof:** `RETIRES THE TOKEN IT REPLACES, so an old mailed link stops
working` asserts the old token is refused and the new one verifies.

### D-295 · The resend is limited by ADDRESS as well as by IP
**Status:** Active

`TOKEN_ENDPOINT_RATE_LIMIT` is keyed by IP, which is right for `verify` and
`reset-password`: those redeem a credential the caller already holds, so the bound is
on guessing. A resend is different — **it sends an email to somebody else's address**
— and an IP-only bound means an attacker with eleven hosts mails one victim eleven
times.

So the endpoint consumes two counters: `tokenEndpointByIp`, shared with the other two
token endpoints, and a new `resendVerificationByEmail` in its own namespace. This is
the same reasoning as `forgotByEmail`, and the separate namespace is the same rule as
everywhere else in this module — a shared counter would let one person's resends spend
another's budget.

The IP counter being SHARED across the three is deliberate and is asserted: three
separate ten-per-hour counters would be thirty attempts an hour at redeeming or
re-mailing a credential from one host.

**Mutation proof:** `TOKEN ENDPOINTS: verify, reset and resend all spend the SAME ten`
and `RESEND-VERIFICATION: allows TEN for one address in an hour and REJECTS THE
ELEVENTH` (the latter rotates the IP on every attempt, so only the address counter can
refuse it).

### D-296 · Two of the new tests passed under their own mutation until they were strengthened
**Status:** Active — recorded as method, not as a defect

Worth a numbered entry because it is the same failure the whole wave is about, caught
inside the wave's own work. On the first mutation run for D-291 — the route deleted —
five of the seven new route tests went red and **two passed**:

- `ANSWERS IDENTICALLY for unknown, unverified and already-verified` was perfectly
  happy with three identical **404s**. Byte-identical is not the property; byte-identical
  **and 200** is.
- `completes the journey: signup, resend, verify, log in` verified using the token from
  the SIGNUP email, which still worked, so the resend returning 404 changed nothing. It
  now asserts the resend returned 200, that a **second** email exists, and continues on
  that token — which is the only token the user in this scenario ever receives.

Both are the D-292 shape in miniature: an assertion that is true of the fixed system
and also true of the broken one. **This is why re-applying the defect is a required
step and not a formality** — without it, two tests named after the fix would have been
committed unable to see its absence.

### D-297 · What this wave did NOT do
**Status:** Open — residue and handoffs

1. **`UserProfile.role` widened on the wire.** `userProfileSchema.role` is now
   `platformRoleSchema` rather than `roleSchema`, because it describes a ROW that
   exists and not an INPUT being accepted (D-293). No byte changes today — nothing
   grants a non-signup role — but the login response's TYPE is wider, and the frontend
   imports these inferred types. **Reported to the frontend owner**; a `switch` on
   `user.role` that the compiler previously proved exhaustive over two cases will now
   want a default.
2. **`roleSchema` is still a hand-written `z.enum(['student', 'parent'])`**, while
   `shared/constants/roles.ts` states in prose that it "is built from `SIGNUP_ROLES`".
   It is not. The two lists agree today and a test pins that they do, so this is a
   documentation defect rather than a live one, and it was left alone deliberately:
   changing it touches the one constant whose separation from `PLATFORM_ROLES` is the
   only thing keeping `super_admin` off a public dropdown, and that deserves its own
   change and its own review rather than a drive-by tidy inside a role-typing fix.
3. **The resend has no client.** The endpoint exists and is tested; nothing calls it.
   `EmailNotVerifiedError` already carries `reason: 'EMAIL_NOT_VERIFIED'` specifically
   so the frontend can offer to resend — that offer is now implementable and is a
   frontend change.
4. **The send is still fire-and-forget.** D-217's deferral is unchanged, and it is
   still weaker than a queue: the process may exit before a send completes. What
   changed is that its stated recovery path is now real, which is the condition under
   which that trade was acceptable in the first place. `platform/jobs` remains the
   right home the day a resend endpoint is not enough.
5. **`AUTHENTICATED_RATE_LIMIT` is not pinned in the identity policy table.** It is
   enforced in `app/plugins`, its literal is already named by
   `src/app/__tests__/authenticated-rate-limit.test.ts` ("REJECTS the 101st request"),
   and it went red under the audit's mutation. Pinning it a second time from a module
   that does not own it would be a second source of truth.

---

### D-281 · The answer key is disclosed once, and the record closes with it
**Status:** Active — `modules/practice`

`POST /practice/sessions/:id/answers` returned `correctPresentationIndex`,
`explanation` and `isCorrect` immediately, and a re-answer to the same question
**replaced** the previous one wholesale — `saveAnswers(session.id, { ...answers,
[id]: answer })`. Nothing carried the discarded selection forward.

An auditor executed the consequence end to end: six questions answered wrong,
each response read for the revealed position, all six re-answered with it.

```
REVEALED CORRECT POSITIONS [1,2,2,0,3,0]
RE-ANSWER SUBMIT 200  scorePercent: 100, correctCount: 6, xpAwarded: 110, isValid: true
RE-ANSWER ROWS (all six)
  first_selected_index: null,  answer_changed: null,  is_correct: true
```

Twelve taps recorded as six correct first-time answers. **Every anti-cheat rule
passed, correctly** — six responses to six questions across ample elapsed time
with four distinct presentation indices. None of the three is about this.

This outranks the rest of the audit because `practice_responses` is the
substrate: mastery, the parent digest, the spaced-retention schedule and the
Phase 1 teacher screen are all computed from it, all of them were fabricable in
two taps, and the resulting row looks like a flawless attempt.

**THE CHOICE: THE REVEAL STAYS AND THE RECORD CLOSES.** A second answer to a
question that already has one is a `ConflictError` — 409.

The alternative — withhold the key until submission and leave answers mutable —
was rejected twice over. **The product argument:** feedback at the end of a
six-question set is a different activity from guided practice. The hint ladder,
the misconception explainer and `decideNext`'s confirm / remediate /
flag-for-recovery branches all exist to act on the answer the student has just
given; deferring the reveal defers all of them and turns step 5 of the session
into a report. **The technical argument, which is the decisive one:** withholding
`correctPresentationIndex` and `explanation` alone would not have closed the
hole. With four options and a mutable answer, `isCorrect` is a three-guess
search — and `isCorrect` cannot be withheld without withholding the whole of
step 5. Immediate feedback and a changeable answer are the pair that cannot
coexist; the fix removes the second.

The guard runs **before the answer key is consulted**, so the refusal is not
itself an oracle: a re-answer that would have been right and one that would have
been wrong are refused identically. Pinned by `refuses the re-answer WITHOUT
disclosing whether it was right`.

Honest clients are unaffected — a client that answers each question once sees no
change. Only the second answer is new behaviour.

### D-282 · `first_selected_index` and `answer_changed` are the server's own
**Status:** Active — `modules/practice`

`firstSelectedIndex` was an OPTIONAL FIELD ON THE REQUEST, translated through the
shuffle map and stored. `answer_changed` was derived from it. The same audit
found both **null on five of six responses in an honest journey**, because the
only source was a field the client had no reason to send.

These are the two columns `schema/practice.ts` singles out as unrecoverable: "a
student who practised in September and changed four answers leaves no trace of
either unless the columns existed in September". `parent`'s misconception query
reads `first_selected_index` specifically — a child who picked the misconception
distractor and then corrected themselves demonstrated the misconception, and the
final answer hides it. A column that is unrecoverable, load-bearing and usually
empty is worse than absent: the report it feeds under-counts silently.

The field is **removed from the contract**, and the derivation moved to
`domain/answer-change.ts` — pure, taking the session's own prior answer. The
contract already refused `answerChanged` for exactly this reason ("a client that
could send it independently is a client that can make them disagree"); this is
the same argument one field over, and the two are now consistent.

`firstSelectedIndex` is now **never null**: with no prior answer the first choice
IS this one, which is a statement about the student. The old `null` was a
statement about the client.

The carry-forward branch — `prior.firstSelectedIndex ?? prior.selectedIndex`,
never `prior.selectedIndex` alone — is unreachable through HTTP while D-281
stands, and is implemented and tested anyway. It is the half of the fix that
survives if immutability is ever relaxed: the exploit would then be RECORDED as a
change with the original index preserved rather than erased. Neither half is
sufficient alone, which is why both are here.

Zod strips unknown keys, so an old client that still sends the field succeeds and
is ignored rather than rejected.

### D-283 · `xpEarned` meant two different numbers in one contract file
**Status:** Active — `shared/contracts/practice.contract.ts`

`SubmissionResult.xpEarned` was the **uncapped** figure and `HistoryEntry.xpEarned`
was the **awarded** one. On a capped session that is 110 from `POST /submit` and 0
from `GET /history`, under one name, in one file the frontend imports — so a
client rendering its own history showed **0 XP for a session the student had just
been congratulated on**, with nothing anywhere to indicate a defect.

`HistoryEntry.xpEarned` is renamed **`xpAwarded`**, which is what
`practice_sessions.xp_earned` actually stores (`completeSession` is handed
`capped.awarded`). `SubmissionResult` keeps both fields — they answer different
questions and the interface needs both to say "you earned 110, 20 withheld
because today's cap is full" — and the two `xpAwarded` now agree by name and by
value. The column keeps its name; only the wire stops lying about which number it
carries.

### D-284 · Two N+1s on the two screens the client opens most
**Status:** Active (partially) — `modules/practice`

`getProgress` called `readChapter` once per mastery row: **one query per chapter
the student has ever practised**, sequentially, on the progress screen — a cost
that grows every week the product is used. Nothing in the loop looks like a
query, which is why it survived review.

Fixed by asking a different question: the student's own grade and subjects give
the whole candidate set in one `listChapters` per subject, and the mastery rows
are titled from that map. `readChapter` remains as a per-row FALLBACK for a
chapter practised before the student was promoted — those are not in this grade's
list, and blanking their titles would be a silent data loss traded for a
performance win. Bounded in the common case, still correct in the uncommon one.

`getTodaysMission` awaited `listChapters` once per subject inside the loop.
That count is bounded by the subject list and does not grow with use, so the fix
here is only that the calls no longer wait for each other (`Promise.all`).

**LEFT UNDONE, AND IT NEEDS ANOTHER MODULE.** `content.listChapters` takes ONE
subject, so the query COUNT on both paths is a `content` API shape and cannot be
reduced from `practice`. A `listChapters({ subjectCodes: string[] })` overload
would make both paths a single query. That is a `modules/content` change plus a
binding in `app/routes.ts`, neither of which this change owns.

Pinned by `issues NO per-chapter read for chapters in the student's own grade`
(a counting seam) and `has BOTH subject reads in flight at once` (a barrier on
the injected seam — the D-246 pattern, not a stopwatch).

### D-285 · The XP payouts are pinned to literals; every assertion was relative
**Status:** Active — `modules/practice/__tests__/xp-rules.test.ts`

Every XP assertion was expressed in terms of the constant it tested:

```ts
expect(calculateXp(5, 80)).toBe(5 * XP_RULES.perCorrect + XP_RULES.highScoreBonus);
```

Both sides move together. An auditor changed `perCorrect` 10 -> 9,
`highScoreBonus` 20 -> 19 and `perfectBonus` 30 -> 29 and **all 2,530 tests
passed** — the entire economy devalued by ten percent against a green suite.

This is the exact failure `xp-rules.ts`'s own header names: "a screen that
promises 10 XP and a ledger that awards 8 ... There is no error, no log line and
no test that fails."

The THRESHOLDS were already safe, by accident: 79, 80, 99 and 100 appear as
literals in the boundary tests, so `highScoreThreshold` 80 -> 70 goes red. Only
the PAYOUTS were unpinned, and `dailyCap` was caught only incidentally by
hardcoded fixture values in another file — which is the same defect one step
removed, because that file is free to change its fixtures.

Fixed the way `anti-cheat.test.ts` already does it (D-190): literals, in the
module that owns them, beside the relative tests rather than instead of them.
The relative tests say the economy has a bar at 80 and two stacking rewards; the
literal pins say what the numbers ARE. Three end-to-end figures are pinned too
(110 for a perfect six, 70 for five-of-six, 200 for a day) so that a change to
the FORMULA also costs a deliberate edit.

### D-286 · What this wave did NOT do, listed so it is not mistaken for done
**Status:** Open — residue

1. **`answer_changed` is structurally `false` today.** D-281 makes an answered
   question immutable, so no answer can change, so the column records a real
   observation that is always the same one. `parent`'s effort signal
   `count(*) filter (where answer_changed = true and is_correct = true)` —
   "recoveries" — is therefore now always 0 rather than occasionally non-zero
   from unverifiable client testimony. **That is a reduction in reported signal
   and an increase in its truthfulness**, and it is stated here because a reader
   of the parent digest will otherwise see a metric flatten and look for a
   regression.

   The way to get the signal back HONESTLY is a two-phase answer: a selection
   that records without revealing, and a separate reveal that closes the record.
   The student's change of mind then happens server-side, before any information
   has left, and `deriveAnswerChange`'s carry-forward branch (already written and
   tested) becomes live with no further change. It is a contract addition and a
   client protocol change, so it is not in this wave.

2. **The N+1 query COUNTS are reduced, not eliminated** — see D-284. Both need
   `content.listChapters` to accept a subject list.

3. **`timeSpentMs` is still client-supplied.** The `realElapsedMs` clamp (D-189)
   is the backstop and it holds; nothing here changed it.

4. **The frontend has no practice client yet**, which is why D-282's request
   narrowing and D-283's rename could ship as contract changes rather than as
   deprecations. The first client to be written against `practice.contract.ts`
   gets the corrected shapes; there is nothing to migrate.

---

## Alerting-observability wave — 11 August 2026

### D-311 · A signal name is only HALF of "can this rule fire"
**Status:** Active — **important**

`assertRulesAreSatisfiable` checked that every rule's SIGNAL NAME was in the
producible set, and its own test file called it "the most important test in this
file … the guard against enforcement that looks installed and enforces nothing".
It never checked the THRESHOLD.

An auditor inflated every shipped threshold to an unreachable value — `1 →
1000000`, `0.9 → 99.0`, `36 → 360000` — and downgraded ten of the eleven `page`
rules to `ticket`. **23 of 23 tests passed.** Every signal name was still
correct, and the entire alert set was disabled.

**Decision:** `SIGNAL_RANGES` in `scripts/ops/alert-rules.ts` declares, per
signal, the range in which a threshold can actually be reached, and the assert
rejects anything outside it. `gte` is bounded above, `lte` below — checking both
directions for both comparisons would reject a legitimately insensitive rule.

A signal with **no** entry is an error rather than a pass. "Cannot be checked"
must never quietly become "is fine"; that is the same inversion `evaluate()`
already refuses one layer down when it declines to read an absent signal as zero.
Adding a signal therefore forces adding its range.

**Consequence:** a rule watching `readiness.failing >= 1000000` now fails the
evaluator at start-up, which is where the D-123 pattern says a mis-configuration
belongs — a monitoring component that refuses to boot is legible; one that boots
and watches nothing is not.

### D-312 · The per-rule pin is transcribed by hand, and that is the point
**Status:** Active

Every test over the shipped rule set was COUNT-shaped. `expect(ALERT_RULES.some(r
=> r.severity === 'page')).toBe(true)` — **a `some`** — is satisfied by one
surviving page rule while ten are downgraded. `cooldownSeconds > 0` is satisfied
by `21_600_000`. Nothing pinned any shipped rule's threshold, severity or
comparison.

**Decision:** a table test in the shape of
`src/platform/config/__tests__/timeouts.test.ts:23-33`, pinning all twelve rules'
`signal / comparison / threshold / severity / cooldownSeconds` to literals, plus
an exhaustiveness check (the table must name every rule) and an exact page/ticket
partition by id.

The numbers are **transcribed, not derived from `ALERT_RULES`**. A table built
out of the thing it checks checks nothing — that is precisely the shape that let
eleven inflated thresholds through. Changing a threshold now means changing it in
two places, in a diff a reviewer sees, which is the same contract the §4 timeout
table has.

### D-313 · A cooldown can disable a rule as completely as a threshold can
**Status:** Active

`cooldownSeconds: 21_600_000` is 250 days and satisfies `> 0`. A rule that
delivers once and then goes quiet for eight months has, in every sense an
operator cares about, fired once — during the deployment nobody was watching.

**Decision:** `COOLDOWN_BOUNDS` = 60s..86_400s, enforced by the same start-up
assert. The floor is one evaluation interval (a shorter cooldown is not a
cooldown); the ceiling is one day, `backup_stale`'s six hours being the longest
legitimate value in the set.

### D-314 · `platform.port.call_failed` — the fast-failure counter, and why it is DISJOINT
**Status:** Active — **important**

`dependency.errors` was `platform.port.timeout` + `platform.breaker.rejected` +
`platform.concurrency.rejected`. All three are emitted by the GUARD when the
guard refuses or abandons a call. A call the DEPENDENCY refuses — connection
refused, DNS failure, TLS reset, a provider 500 an adapter throws on — increments
none of them: it returns in milliseconds, far inside its timeout, and the breaker
files the failure privately and emits nothing until it transitions at five.

Measured against the real production wiring with a failing port:

```
EMBED-DOWN turn:      502 DEPENDENCY_FAILURE
EMBED-DOWN metrics_events: []
PAY-DOWN checkout:    502 DEPENDENCY_FAILURE
PAY-DOWN metrics_events: []
```

**Empty.** A payments outage that failed four checkouts and recovered was
completely invisible, and that is the single most common shape an outage takes:
things fail FAST, not slow.

**Decision:** a fourth counter, `PLATFORM_METRICS.PORT_CALL_FAILED`, emitted
through `src/platform/metrics/port-failure-bridge.ts` — a bridge for the same
reason `createBreakerMetricsBridge` is one: `platform/resilience` wraps any port
and must not know what a metric is called.

It is **disjoint by construction**. `classifyPortFailure` recognises a timeout, a
breaker rejection and a concurrency rejection STRUCTURALLY (`details.timeoutMs` /
`details.breaker` / `details.max` — the same discrimination `isWorthRetrying`
uses, never message text) and declines to emit for them, so the collector can SUM
all four. A double-counted error rate is worse than a missing one: it is a number
people quietly stop believing, and then stop looking at.

Anything else counts, **including a plain `Error`** from an adapter that never
wrapped its failure. Requiring the wrapper would make the counter depend on every
adapter author having remembered, and the adapter that forgot is the one whose
outage goes unseen.

Added to `IMMEDIATE_FLUSH_METRICS` (D-232): a total provider outage is the shape
that EMPTIES the buffer rather than filling it, so the 100-row count trigger
cannot be relied on for it.

### D-315 · What `platform/resilience` still has to do for D-314
**Status:** Open — **cross-owner dependency**

The bridge, the metric name, the immediate-flush entry and the collector summand
all exist and are tested. **The emission is not wired**, because
`src/platform/resilience/port-guard.ts` and `registry.ts` are not owned by this
change. Until they are, `platform.port.call_failed` is always zero and
`dependency.errors` still counts only the three guard-raised failures.

Required, exactly:

1. `PortGuardOptions` gains `onFailure?: (name: string, error: unknown) => void`,
   alongside the existing `onTimeout` / `onRetry` callbacks and shaped the same
   way (a callback, not a `MetricsPort`).
2. `createPortGuard.run` invokes it for **every** rejection leaving the guard —
   including timeouts and both rejections. The filtering belongs in the bridge,
   not the call site, so the guard stays ignorant of what is already counted.
   Cleanest seam is a `.catch` that re-throws around the returned promise.
3. `createResilienceRegistry` wires it as the sixth emission:
   `onFailure: createPortFailureBridge(metrics)` — a single line, since the
   bridge's signature is already `(port, error) => void`.
4. `ResilienceRegistryOptions.metrics`' header says it wires "FIVE emissions"
   (D-278 exists solely because that count went stale once). It becomes six.

Recorded rather than done, and recorded with the exact signature, because the
alternative is a bridge with a test and no caller — which is
`createNoopBreakerMetrics` all over again.

### D-316 · The heartbeat alert is evaluated PER WORKER, oldest live one, tombstones excluded
**Status:** Active — **important**

`collectWorkerHeartbeatAge` was:

```sql
select extract(epoch from (now() - max(last_beat_at))) as age_seconds
from worker_heartbeats
```

No status filter, and `max()` across all replicas. Reproduced twice against a
real database:

1. Two rows, one 3600s stale (`status='running'`) and one fresh → evaluator age
   **0.01s**, no page. `max()` takes the NEWEST beat, so one healthy replica
   hides any number of corpses.
2. A single **cleanly stopped** worker with nothing else running → age ~0s, and
   `count(*) where status <> 'stopped'` = **0**. Every job in the product is
   stopped and the page stays quiet for its whole 300s threshold, because a
   `stopped` row keeps its timestamp forever. The alert was reading a tombstone
   as a pulse.

`heartbeat.ts:34-37` designed per-process rows explicitly so "a dead replica [is]
visible as a stale row". The evaluator aggregated them back into exactly the
single shared row that design was avoiding.

**Decision:** `where status <> 'stopped'`, then `min(last_beat_at)` — the OLDEST
live worker — because the question the page answers is "is ANY worker dead", not
"is the fleet dead". Zero live rows returns `Number.MAX_SAFE_INTEGER` rather than
being unmeasurable, on the same reasoning as a missing backup: a worker never
deployed, a worker that died, and a worker stopped and never replaced are one
outage from a user's point of view, and treating the first as unmeasurable means
the alert never fires on the deployment where the worker was simply forgotten.

`readWorkerLiveness` in `platform/jobs` already does exactly this, per row and
status-filtered. It is **not** reused because it currently throws (owned
elsewhere, fixed in parallel). Reusing it is the right end state and is left as a
follow-up rather than done blind against a function known to be broken.

### D-317 · `platform.notify.undeliverable` — D-146 closed
**Status:** Active (supersedes the gap recorded in D-146)

`dispatcher.ts` detected "every channel failed" from the beginning and logged it
at `error` as `notify.undeliverable`. **A log line is not a signal**: nothing
aggregates it and no rule can watch it, so `alert-rules.ts` carried a comment
saying the metric an operator actually wants "does not exist" and filed it as
D-146 rather than writing a rule against nothing.

`platform.notify.failed` could not be given a threshold instead, and the reason
is the whole point: it counts DELIVERIES, **per channel**. One notification
failing on both of its channels and two notifications each failing on one while
their other channel lands both produce `notify.failed = 2`. The first is a person
who was never told something the system decided they needed to know; the second
is a degraded provider and a working product.

**Decision:** `PLATFORM_METRICS.NOTIFY_UNDELIVERABLE`, emitted once per
notification in the `!delivered` branch, tagged with the **kind only** — never
the recipient (PII) and never the channel list joined into a string (unbounded
cardinality). Collected as `SIGNALS.NOTIFY_UNDELIVERABLE` and watched by a new
`notify_undeliverable` rule at threshold **1**, severity `ticket`.

Threshold 1 because there is no healthy baseline to sit above — a threshold of 5
would only be choosing how many people to silently not inform. `ticket` rather
than `page` because the product is up and the fix is never at 3am: a deleted
user's foreign key, a missing tenant, or credentials to rotate in the morning.

### D-318 · The rate-limit fallback is emitted under more than one name, and one was uncollected
**Status:** Active

`platform/rate-limit` takes its metric name from the constructor, so each limiter
namespaces its own. The collector's `METRIC` map held
`identity.rate_limit.in_process_fallback` only. Under a cache outage an audit
observed **six activations** of `app.authenticated_rate_limit.in_process_fallback`
— built in `src/app/server.ts:150`, already in the D-232 immediate-flush set —
and **zero pages**, because nothing was looking at that name.

D-034's whole point is that a silent security downgrade is found out. Collecting
one of the two limiters that can degrade is finding out half the time.

**Decision:** `rate_limit.fallback` sums the identity limiter and the app-level
authenticated throttle. The rule body is amended to say so, because the number in
a page has to mean what the sentence beside it says.

`billing.webhook_rate_limit.in_process_fallback` is **deliberately excluded** and
pinned by a test asserting it contributes zero. It is a webhook throttle, not an
authentication control; folding it into a page whose body reads "authentication
rate limits are per-instance and weaker" would make the alert text false on every
billing occurrence. If it warrants an alert it warrants its own rule.

### D-319 · The alerter's own mail goes through the guard — a wedged SMTP server stalled every rule
**Status:** Active — **important**; nodemailer socket timeouts remain **Open**

`alert-evaluator-main.ts` built `createSmtpMail` **raw**, not through
`createGuardedMail`, and `createNodemailerTransport` sets no `connectionTimeout`,
`greetingTimeout` or `socketTimeout`. So a TCP connection that opens and then says
nothing had no deadline anywhere in the stack.

`deliver()` is awaited inside `runCycle`, which is awaited by `runOnce`, which is
awaited by the loop. **One hung socket on one page-severity alert suspended the
entire evaluator** — readiness, pool saturation, backups, worker heartbeat, every
rule — for as long as the peer held the connection. The monitoring system's own
dependency taking the monitoring system down is the inversion §5 exists to
prevent, and it fails silently: the process is alive, the container is healthy,
and no alert has been produced for an hour.

**Decision:** the ops path builds its own single-purpose `ResilienceRegistry`
from the same `config.timeouts` / `config.concurrency` / `config.breaker` the API
uses, and wraps the SMTP adapter in `createGuardedMail(raw, guard('mail'))`. A
wedge now costs one cycle of latency (the `mail` rule's 10s), and after five
costs nothing at all once the breaker opens. `createGuardedMail` deliberately
does not declare mail idempotent (D-237), so this adds a deadline without adding
a duplicate page.

**Still open, and owned by `platform/mail`:** `createNodemailerTransport` should
set `connectionTimeout`, `greetingTimeout` and `socketTimeout`. A socket-level
deadline is strictly better than an outer race, because the race leaves the
wedged socket open — the guard bounds the CALLER's wait, not the connection.

### D-320 · The runbook path travels in the BODY, because `data` does not survive the email channel
**Status:** Active; the channel-side fix remains **Open**

`alert-evaluator.ts:102-110` puts `runbook`, `ruleId`, `value` and `threshold` in
`ChannelMessage.data`. `email-channel.ts:77-84` maps only `kind`, `title`, `body`
and `language` onto the one mail template — `MailPort.data` is
`Record<string, string>` and the channel deliberately refuses to widen it, which
is correct and is documented in its own header.

The consequence went unnoticed: **every other field in `data` is dropped between
the evaluator and the inbox.** The on-call email arrived carrying a body that
refers to the runbook and no runbook path. At 3am that is several minutes of
somebody grepping `docs/runbooks/` on a phone, and it is the most actionable line
in the message.

**Decision:** `withRunbookLine()` appends `Runbook: <path>` (and `रनबुक:` in
Hindi, P7) to the body at delivery. Fixed in the body rather than in the channel
so it survives EVERY channel — in-app today, whatever pager adapter lands later —
without each one deciding to render a payload field. `data.runbook` is kept as
the machine-readable copy for the in-app row.

**Still open, and owned by `platform/mail` + `notify-channel/email-channel.ts`:**
the correct end state is a real `ops-alert` `MailTemplate` with its own typed
fields, at which point the body append becomes redundant. Reusing
`weekly-digest` is a stand-in and the email-channel header already says so.

### D-301 · "Stop claiming immediately" checked the call, not the result — and the miss also hung the process
**Status:** Active — fixed

`job-runner.ts` checked `stopping` immediately before `queue.claim(...)` and
nowhere else, while its own header claimed "the instant a signal arrives the loop
must not take another job". `claim` is a network round trip. **A SIGTERM landing
inside it is the common case on a deploy, not an exotic interleaving** — so the
flag flipped while the statement was on the wire, the claim came back holding a
job, and the loop ran it. That job is then killed by the drain deadline and
returned by the reaper, so it runs twice for no reason at all: exactly what the
check existed to prevent.

The second half was worse and is the one that reached production behaviour.
`runStop` read `const inFlight = current`, and in this race `current` is
`undefined` — nothing is executing, the claim has not returned. The `withDeadline`
branch was therefore **skipped entirely** and control fell through to an
unbounded `await stopped`, on a loop parked on the very claim that had not come
back. `stop()` never resolved and `worker.drain_timeout` was never logged. Since
`worker-main.ts` awaits `worker.stop()` inside the signal handler,
`container.shutdown()` and `process.exit(0)` were never reached: **the process
hung until SIGKILL, which is the outcome the deadline exists to prevent.**

**Decision:** the flag is re-read AFTER the claim resolves, in `claimOrRelease`,
and the in-flight CLAIM is tracked in `claiming` alongside `current` so
`stop()` can see "the loop is busy" even when the busy part is not a handler.

**Proved by mutation.** Removing the post-claim check reds four named tests
across the unit and integration suites; restoring the original `runStop`
(`inFlight = current` plus the unbounded `await stopped`) reds
*"applies the drain deadline to a claim in flight, instead of hanging forever"*
with the promise still `pending` after 80 turns — the hang itself, as an
assertion rather than as a timeout.

### D-302 · A job claimed into a shutdown is RELEASED — not run, not dropped, and not failed
**Status:** Active — new queue method

D-301 leaves a job in hand that must not be started. All three obvious disposals
are wrong, which is why `JobQueue` grew a fourth completion method rather than
reusing one:

- **Run it** — forbidden by §12 step 3, and it will be killed and rerun anyway.
- **Drop it** — the row stays `running` behind a lease nobody holds, invisible
  until the 120-second reaper. A two-minute delay on work never started.
- **`fail` it** — it did not fail. That writes a `last_error` describing an error
  that never happened AND pushes `run_at` out by the backoff, so every job
  unlucky enough to be claimed during a deploy is delayed 30 s minimum.

**Decision:** `release(job, now)` — back to `pending`, `run_at` untouched,
`last_error` cleared, **`attempts` decremented**, fenced by the lease exactly like
`succeed`/`fail` (D-233). The decrement is the non-obvious part: the claim is
being UNDONE rather than completed and the handler was never invoked, so leaving
`attempts` raised would let a rolling deploy across five restarts walk a job that
has never run once all the way to `dead`. `greatest(attempts - 1, 0)` so a
concurrent reclaim can never drive it negative.

Pinned against a real database in `tests/integration/worker-shutdown.test.ts`,
including that a STALE worker's release is refused by the same fence — the new
write is not a hole in D-233's.

### D-303 · A completion write that threw aborted the shutdown before the heartbeat could stop
**Status:** Active — fixed

`execute`'s `catch` called `await queue.fail(...)` **outside any try**. The
realistic co-occurrence is not exotic: **a database blip during a deploy makes
the handler throw AND makes the failure write throw.** `execute` rejected,
`withDeadline` propagated it, `runner.stop()` rejected — and `worker.ts`'s

```
await runner.stop(reason);   // rejects
await heartbeat.stop(...);   // NEVER RUNS
```

meant the heartbeat row stayed `running`, went stale at 300 s, and
`worker_heartbeat_stale` **paged somebody on a clean deploy**. That consequence
was already written down four lines above the defect, in `worker.ts`'s own
comment: "the difference between 'deploy went fine' and 'page somebody'".

**Decision:** three layers, deliberately, and the redundancy is the point because
each one is owned by a different file.

1. `recordCompletion()` wraps every completion write (`fail` on the no-handler
   path, `fail` on the failure path, `release`) and logs
   `job.completion_write_failed`. Swallowing it loses nothing: the row keeps its
   lease and the reaper returns it. Losing the SHUTDOWN is unrecoverable.
2. `withDeadline` treats a rejection as FINISHED rather than rethrowing. The
   question it answers is "is it still running?", and a promise that rejected is
   not still running.
3. `worker.stop()` wraps `runner.stop()` in its own try/catch, so the ordering
   promise holds for a reason this file can enforce locally rather than depending
   on a property of another module that a future change could quietly remove.

**Proved by mutation:** reverting layer 1 alone reds three named tests; reverting
all three reproduces the original failure exactly — `worker.stop()` rejects with
`db down: could not record failure` and *"still marks the heartbeat row stopped
rather than leaving it running"* goes red.

### D-304 · `app.close()` rejecting skipped `closeResources()` and `exit(0)` — flagged before, unchanged
**Status:** Active — fixed

Same shape as D-303, in `src/app/shutdown.ts`, and **it had already been reported
by a previous audit and was still there.** `const drained = await
withDeadline(app.close(), drainTimeoutMs)` was bare. Fastify's `close()` runs
every registered `onClose` hook, so any plugin teardown that rejects — a cache
client already gone is the everyday one — made `run()` throw before the pools
were released and before the process exited. Connections stayed held on the
database until it timed them out, and the process sat there until SIGKILL:
precisely the outcome that file's own header says the deadline exists to avoid,
reached through a different door.

**Decision:** the drain is wrapped; a failure leaves `drained` **false** and gets
its OWN log line. "The drain timed out" and "the drain blew up" are different
incidents, and reporting `drained: true` for a drain that threw would be worse
than silence.

Proved with a real Fastify instance and a real rejecting `onClose` hook rather
than a stub with a rejecting `close` — the failure mode is *plugin teardown*, and
a stub would only prove that a rejecting function rejects.

### D-305 · `readWorkerLiveness` threw on the first real row — D-233/D-267 again, same directory, same driver
**Status:** Active — fixed

`heartbeat.ts` declared `last_beat_at: Date` on a raw `db.execute` and called
`row.last_beat_at.getTime()`. The driver returns **wire text**. Against real
Postgres: `TypeError: row.last_beat_at.getTime is not a function`.

This is the identical defect D-233 found and D-267 finished in
`postgres-queue.ts` — **in the same directory, on the same driver** — where a
long comment types all three timestamps `Date | string` and predicts this exact
failure: "the first caller to write `job.runAt.getTime()` gets a `TypeError` in a
worker, at runtime, with a compiler that had already signed off on it."
`heartbeat.ts` was simply not repaired in that wave.

The only reason nobody hit it is that **the function has zero callers and had
zero tests** — which is not evidence it was safe, it is evidence it was
unexercised. Its own header advertises it for `/health/deps`; wiring it in as
written would have **500'd the health endpoint**, the one thing that must not
fail while everything else is.

**Decision:** typed as the union the driver actually returns and normalised once
at the row boundary, so `WorkerLiveness.lastBeatAt` is the real `Date` it has
always claimed to be. Pinned against a real container.

### D-306 · One shared budget bounds the whole of `stop()`, not just the handler
**Status:** Active

The old `runStop` applied `shutdownTimeoutMs` to the in-flight job and then
awaited the loop **unbounded**, on the reasoning that a loop whose drain finished
ends promptly. That is true of the handler and false of everything else in an
iteration: `reapStuck`, and `onTick`'s scheduler probe and heartbeat, are all
database calls — and a database that has just become unreachable is exactly the
condition under which a deploy is happening.

**Decision:** one deadline instant computed at the top of `runStop`, spent across
both waits via `remainingMs()`. `shutdownTimeoutMs` is the promise made to the
orchestrator; it has to bound the whole of `stop()` or SIGKILL arrives and skips
every remaining cleanup step. The timeout branch still deliberately does NOT
await the loop — abandoning a job to the reaper is the documented at-least-once
edge, and awaiting it would honour a window it had just reported exceeding.

### D-307 · `worker.ts` was at 0% coverage because it demanded the whole `Config` and built its own queue
**Status:** Active — two seams added

The file owning the shutdown choreography had **no tests at all**, and
`scheduler.ts` had 27.58%. That is not an oversight anyone chose; it is what the
constructor's shape made cheap. `createWorker` took the full `Config` — ~30 frozen
sub-objects behind boot-time validation — so it was reachable only from a process
that had already parsed the environment, and it built its own Postgres queue, so
the failure that matters most (a completion write that throws) was unreachable
against a healthy container.

**Decision:** two narrow seams, both justified independently of testing.

- `WorkerConfig` — the slice this process actually reads (`env`,
  `shutdown.workerTimeoutMs`). The real `Config` satisfies it structurally, so
  `worker-main.ts` is unchanged. Same rule `notify.service.ts` already follows
  with "the narrow slice of `JobQueue` this module needs".
- `WorkerDeps.queue?` — defaults to the real Postgres queue; nothing in
  production passes it.

A constructor that can only be called by the composition root is a constructor
whose behaviour is asserted nowhere, and this one's behaviour is whether a deploy
pages somebody.

### D-308 · What the coverage gap actually cost, stated as a number
**Status:** Active — measurement

After this wave, on the targeted suites: **`worker.ts` 90.72% statements / 100%
functions** (from 0%), **`scheduler.ts` 100% across all four metrics** (from
27.58%), `job-runner.ts` 98.39%, `heartbeat.ts` 100% statements,
`shutdown.ts` 95.83%.

The residual uncovered block in `worker.ts` is lines 302-311 — the try/catch
around `runner.stop()` from D-303 layer 3. It is **genuinely unreachable now**
that `runner.stop()` cannot reject, and it is kept anyway: it defends an ordering
promise against a future change in a different file. Recorded here so the next
reader does not "clean up" a deliberate guard on the strength of a coverage
report.

Worth stating plainly because the audit that opened this wave predicted all of it
in one sentence — *"the shutdown-ordering choreography is exactly what regresses
silently"* — and four defects had already accumulated behind that 0%.

### D-309 · Test-side rules this wave had to obey, and the one that nearly produced a flake
**Status:** Active — testing note

Two things here are not obvious and both were found the hard way.

**"Did `stop()` hang" is measured in event-loop TURNS, not in a duration.**
`await`ing a promise that never resolves gives a bare 15-second vitest timeout
with nothing to say about why. `settlement()` races the promise against N turns
and returns `'pending'`, so the hang becomes a named assertion with a readable
message. A turn yields through `setTimeout(0)` rather than `setImmediate` so the
timers phase runs and a deadline that IS due can fire — no duration is waited out
and nothing encodes how long anything takes, which is what §9.5 actually bans.

**`worker.start()` never resolves — it IS the loop — so "the worker is up" has to
be OBSERVED.** A test that called `stop()` straight after `start()` raced the boot
heartbeat against the stopping write, and the row could end up `running` for a
worker that had shut down perfectly. That flake appeared only under `--coverage`,
which is the worst way to find it. `startAndSettle()` waits for the boot beat to
land first.

### D-310 · What this wave did NOT do, listed so it is not mistaken for done
**Status:** Open — residue, owned by other agents

1. **`readWorkerLiveness` still has zero callers.** D-305 makes it safe to wire;
   it does not wire it. `/health/deps` lives in `src/app/health.ts`, which this
   wave does not own. The heartbeat blindspot is only closed when something
   actually reads the row — and now that it no longer throws, that is a one-line
   change rather than an incident.

2. **`src/app/container.ts` fails lint** — `'servesRequests' is assigned a value
   but never used` (line 452). Not this wave's file and not this wave's change;
   `npm run lint` therefore exits 1 repo-wide while every file in
   `src/worker/`, `src/platform/jobs/` and `src/app/shutdown.ts` is clean.

3. **`worker-main.ts`'s own shutdown path is still untested.** Its `stopping`
   guard, the two `catch` blocks and `process.exit(0)` are structurally identical
   to what is now pinned one level down, but the entry point itself has no test —
   it would need the process signal handlers injected the way
   `createShutdownController` already injects `onSignal` and `exit`.

4. **`release` is not exercised by `tests/integration/job-queue.test.ts`.** Its
   SQL is covered through the worker suite instead. The queue's own file is the
   more natural home for the fence and the `attempts` arithmetic, and that file
   was left alone this wave to avoid colliding with concurrent work.

### D-321 · The Foxy daily cap is pinned to LITERALS, because every test referenced the symbol
**Status:** Active — product invariant

`FOXY_DAILY_MESSAGE_LIMIT` is `{ free: 20, plus: 200 }`. An audit changed it to
`{ free: 5000, plus: 9000 }` and the entire suite stayed green.

Not because the limit was untested — it is exercised in `foxy.service.test.ts`,
`usage.test.ts` and `foxy-plan-reader.test.ts` — but because every one of those
places asserted `FOXY_DAILY_MESSAGE_LIMIT.free`, never a number. **A
symbol-relative assertion moves with the symbol**, so a suite made entirely of
them pins the plumbing perfectly and says nothing at all about the value. The
single absolute claim anywhere was `plus > free`, which any ordered pair
satisfies — 5000/9000 included.

Meanwhile FIVE comments (`modules/foxy/index.ts:126`, `foxy.types.ts:63`,
`app/routes.ts` twice, `foxy-plan-reader.test.ts:15`) went on stating the free
cap as 20. That is the D-257 shape in prose: behaviour and documentation drift,
documentation stays authoritative-looking, nothing mechanical relates the two.

The commercial half matters as much as the mechanical one. D-257 fixed "every
paying customer silently received the free tier" **structurally**, while the
effect it was about — a paid tier worth buying — was absent: 5000 versus 9000 is
1.8x on a ceiling no student reaches, and the free tier's model spend was bounded
by nothing any test could observe.

`modules/foxy/__tests__/daily-message-limit.test.ts` now asserts, as literals:
`free === 20`, `plus === 200`, `free <= 60` (a cap nobody reaches is not a cap),
`free >= 10` (nor is a demo a product), `plus / free >= 5`, and the boundary
through `decideUsage` so the table is provably the number that decides. Changing
either number is a commercial decision and now fails a test that names itself.

Two stale paragraphs were also reconciled rather than left: the `FOXY_PLANS`
header's "`billing` does not exist yet" and `app/routes.ts`'s identical sentence
in the foxy block.

### D-322 · The module-to-pool wiring was asserted NOWHERE, under a test named after it
**Status:** Active — §3.1 bulkhead

`routes.test.ts` carried a test called *"hands each module the pool §3.1 assigns
it"*. **It never called `buildModules`.** Its eleven assertions read
`built.poolFor('foxy').name === 'ai'` — the `MODULE_POOLS` lookup table evaluated
against the container, with the composition root absent from the test entirely —
and the very next test re-asserted the same table directly. The table was checked
twice; the wiring zero times.

Proved rather than argued: an auditor changed `routes.ts:633` from
`container.poolFor('foxy')` to `container.poolFor('identity')` — putting a Foxy
turn, which holds its connection across a model call, onto the ten connections
reserved for login, the precise failure §3.1 exists to prevent — and ran the app
suite: **164/164 passed.**

`src/app/__tests__/module-pool-wiring.test.ts` closes it. No module exposes its
handle (and none should — a module that could show you its pool is a module that
could choose it), so `poolFor` is replaced by a factory issuing a **trap handle
tagged with the module name it was asked for**. The tag is the MODULE, not the
pool, so `poolFor('foxy')` and `poolFor('identity')` are distinguishable even
when they resolve to the same pool. A trap's `db` is a proxy that records its tag
and throws, ending the driver at the first database access; the driver table is
total over `ModuleName`, so a new module with no way to observe its handle does
not compile. 24 cases: eleven modules in the API, eleven in the worker
(`forWorker` must swap every one), plus the two name-level assertions.

**The driver choice is a constraint, not a detail, and it is the subtle part.**
`foxy.listSessions` resolves the tenant through identity before touching anything
of its own, so it reports `identity` no matter how foxy is wired — permanently
green, permanently meaningless, the same defect one layer down.
`foxy.getTranscript` loads the session from foxy's own repository first. Same for
`practice.getSession` over `getHistory`, `parent.digestSource.findParentsDue`
over `getChildren`, `billing.handleWebhook` (with a genuinely signed delivery)
over anything authorised, and `notify.deliver` over `getUnreadCount`.

Re-applying the mutation now turns two NAMED tests red: *"foxy reaches for its
own handle first"* (`reached: 'identity'`) and *"requests all eleven module
names"*. The old test was renamed to *"resolves each module NAME to the pool §3.1
assigns it"* — it keeps its value under a name that claims only what it does.

Also recorded: `notify` legitimately asks `poolFor` twice (the module and its
write-through preferences store), so the name assertion is a SET rather than a
multiset — pinning the multiset would turn a second correct call into a failure.

### D-323 · Boot gates: both fixtures satisfy EVERY gate, and the refusals are scoped by process role
**Status:** Active — deployment

Two defects in one place.

**(a) The fixtures encoded gate ORDER while claiming to assert gate CONTENT.**
`createContainer` runs its production refusals in source order — mail, embed,
llm, payments, migration journal — and every one throws. `boot-gates.test.ts`'s
`PRODUCTION_ENV` was explicitly *"everything a production boot needs EXCEPT
mail"*, so every case in it passed for whichever gate happened to be first among
the unmet ones. `wiring.test.ts` had learned this in the D-226 wave and fixed its
own block; this file was not given the same treatment. An auditor inserted one
realistic new gate ahead of mail and **13 tests went red across both files, none
of them about the new gate** — including the block whose header promises "a gate
added ahead of payments tomorrow cannot break this block".

`PRODUCTION_ENV` now satisfies every gate and each case removes exactly the
variable it is about, via `without(...)`. A satisfied gate does not throw and
therefore cannot be what a case observes. A new case, *"refuses for the MAIL
reason, not because some other gate was unset"*, states the property directly.

Re-run of the auditor's experiment with the complete fixtures: insert the gate,
add its variable to both bases, **42/42 pass**. That is the durable property —
no fixture can pre-satisfy a gate that does not exist yet, but adding a gate must
cost exactly one line per base and break nothing else.

Also removed from that fixture: `SESSION_SECRET` and `IP_HASH_SALT`. **Neither is
a configuration key.** `SESSION_SECRET` appears nowhere in `src/`; the real
variable is `IDENTITY_IP_HASH_SALT` (D-223). They contributed nothing while
making the fixture look exhaustive, which is worse than an obviously partial one:
a reader checking "did they set everything" sees two secrets and stops looking.

**(b) The gates were role-blind.** `worker-main.ts` calls
`createContainer(config, { role: 'worker' })`, and a worker sends the weekly
digest and nothing else — `createWorker` is handed `modules.notify` alone — yet
it refused to start without `VOYAGE_API_KEY`, `LLM_API_KEY` and all three
`RAZORPAY_*` credentials, none of which it can reach. A refusal naming a
credential the process cannot use is not safety; it is a deployment that will not
start for a reason nobody can act on, and the usual resolution is to paste a
placeholder — which makes the next refusal on that variable meaningless
everywhere, including in the api where it matters.

The container already knows the role (it trims the pools with it), so this cost
one boolean. `embed`, `llm` and `payments` are gated for `role === 'api'` only.
**Mail is NOT scoped** — both processes send it. **Nor is the migration journal**
— it is a statement about the schema rather than a credential, and a worker
writing into a half-migrated database is the same hazard as an api serving from
one. The role still defaults to `'api'`, the conservative reading.

### D-324 · `container.authz` is the CONTENT-ONLY guard, and it now says so out loud
**Status:** Active — authorization boundary

It was built as `createAccessGuard({ readLinkStatus: () => null })` under the
comment *"the link reader is wired to the identity repository in build step 4"*.
Build step 4 shipped. The line did not change. **This is D-257's
`readPlan: () => null` one file over, still live.**

Harmless BY ACCIDENT: every module builds its own per-call guard from its own
async link edge, and the only consumer of this member asks about
`{ kind: 'content' }` — the one resource kind whose rules never consult a link.
But it is a **public member of `Container`, typed `AccessGuard`, that silently
denied every parent-child relationship.** The next caller to reach for it instead
of building their own would have got a boundary returning "denied" for every
approved parent, with no error and nothing distinguishable from a correct
refusal.

**It cannot be wired properly at this seam.** `LinkStatusReader` is SYNCHRONOUS,
every real link status is an async database read, and no module is constructed in
the composition root. A correct reader is not merely missing here — it is not
expressible here. Removing the member was the other candidate and was rejected
because its one consumer lives in a file this change does not own
(`modules/content/__tests__/content.service.test.ts:526`).

So the reader now throws a named error (`UNWIRED_LINK_READER`, exported so the
test pins the WORDING, which is the whole value). Both postures are fail-closed;
only one can be told apart from a genuine authorisation decision.
`container-authz.test.ts` asserts all three halves: `{ kind: 'content' }` still
decides, a parent-child question throws the named error and specifically NOT a
`ForbiddenError`, and every deny that does not need a link (student to another
student, parent writing, tenant mismatch) is still exactly a `ForbiddenError` —
so the change cannot have turned genuine 403s into 500s.

The durable fix is `LinkStatusReader` becoming async, or the member being deleted
once its one test consumer moves. Both are outside this change.

### D-325 · `readChapter`'s bare `catch` turned a pool exhaustion into a 404
**Status:** Active — resilience

`app/routes.ts`'s practice wiring read
`try { return await content.service.getChapter(actor, chapterId); } catch { return null; }`.

A withdrawn chapter is a `NotFoundError` inside `content`, and practice genuinely
wants that as a VALUE — it has its own wording, and a session whose chapter was
withdrawn mid-flight must not surface content's. But a bare catch is a translator
that cannot tell the two kinds of "no chapter came back" apart. A pool
exhaustion, a statement timeout, a breaker rejection or a `ForbiddenError` became
"there is no such chapter": nothing propagated, no breaker counted a failure it
should have, no metric moved, and the student was told the chapter does not exist
— the one answer guaranteed to make them stop looking. `platform/db` under load
would have presented as a curriculum that had quietly emptied.

Narrowed to `if (error instanceof NotFoundError) return null; throw error;`.

Not yet pinned by a test: the closure is a local inside `buildModules` with no
seam to reach it from, and provoking it needs a `content`/`practice` service test
that injects a failing chapter read. Left for the owner of those suites.

**RESOLVED by D-334 (11 August 2026).** The seam was made rather than found: the
closure is now the exported `createPracticeChapterReader`, and its eight tests
need no service, no container and no database.

### D-326 · The service-test harness handed modules UNGUARDED ports for three of them
**Status:** Active — test fidelity

`tests/helpers/app-harness.ts` asserts of itself, three times, that it uses "the
same wiring as `app/routes.ts`". For `llm`, `cache` and `mail` that was false.
It passed the raw `MemoryCache`, the raw `RecordingMail` and the delegating
`FakeLlm` straight into the modules, while production passes `container.cache`,
`container.mail` and `container.llm` — each of which leaves the composition root
already wrapped in its concurrency limit, its circuit breaker and its timeouts
(04-RESILIENCE-PLAN.md sections 3.3, 4 and 5).

The container's own header states the property that made the gap invisible: "no
downstream caller can hold an unguarded port — not because they were told not to,
but because one is never handed out". **The harness was handing them out**, so no
service test in the repository exercised the breaker, the concurrency limiter or
either LLM timeout on the paths that actually carry them.

The delegating LLM is now constructed BEFORE the container and passed as the
`llm` override, so `container.llm` wraps it and `useLlm` still swaps the script
underneath the guard; modules receive `container.cache` and `container.mail`. The
RAW objects remain on the harness (`harness.cache`, `harness.mail`,
`harness.llm`) because a test has to read what was recorded and clear it between
cases. 404/404 owned tests pass with the guards in place.

No test yet asserts the guards are there — reverting this change leaves the suite
green, which is the same defect class this entry is about. A breaker /
limiter / first-token-timeout service test is now POSSIBLE for the first time and
is left for the testing owner.

### D-327 · What this wave did NOT do
**Status:** Open — residue

1. **`container.authz` still exists as a public member** (D-324). It throws
   instead of lying, which is strictly better, but the durable answers are an
   async `LinkStatusReader` or deletion of the member. Both touch files outside
   this change.
2. **`readChapter`'s narrowing has no test** (D-325). **CLOSED by D-334** — the
   closure was lifted to an exported function and now has eight tests, five of
   which go red if the bare catch returns.
3. **The harness guards have no test** (D-326).
4. **`wiring.test.ts`'s `PRODUCTION_BASE` and `boot-gates.test.ts`'s
   `PRODUCTION_ENV` are two complete fixtures of the same thing.** They should be
   one exported constant. Merging them means one file importing from the other or
   a third helper, which is a wider change than this wave.
5. **The `notify` module asks `poolFor('notify')` twice** — once for itself and
   once for its write-through preferences store. Correct, but it is why D-322's
   name assertion is a set; a module needing two handles for two reasons is worth
   a look when preferences get their HTTP path (D-280 item 2).

## Observability and deadline wave — 11 August 2026 (D-331 to D-334)

### D-331 · `platform.port.call_failed` was emitted by NOTHING, so the metric it feeds was always zero
**Status:** Active — **important**

`dependency.errors`, the signal both dependency alert rules watch, is the sum of
four counters. Three of them — `platform.port.timeout`,
`platform.breaker.rejected`, `platform.concurrency.rejected` — are emitted when
the GUARD abandons or refuses a call. The fourth, `platform.port.call_failed`, is
the one for when the DEPENDENCY ITSELF refuses, and it existed, had its own bridge
(`createPortFailureBridge`), had its own unit test, was listed in
`IMMEDIATE_FLUSH_METRICS`, and was summed by `alert-sources.ts` — and **nothing
ever called it.**

A dependency that fails fast was therefore invisible to every rule. An auditor
drove the real production wiring with a failing port and read the table back:

    EMBED-DOWN turn:      502 DEPENDENCY_FAILURE
    EMBED-DOWN metrics_events: []
    PAY-DOWN checkout:    502 DEPENDENCY_FAILURE
    PAY-DOWN metrics_events: []

Empty, both times. Connection refused, DNS failure and provider-500 are the most
common shape an outage takes; they return in milliseconds, far inside their
timeout, and the breaker keeps its failure count privately until it transitions at
five. So a payments outage that failed four checkouts and recovered left no trace
anywhere an alert rule could see, and `dependency_error_rate_high` could only ever
count timeouts and post-breaker rejections.

**Decision:** `PortGuardOptions` gains `onFailure?: (name, error) => void`, shaped
like the existing `onTimeout` / `onRetry`. `createPortGuard.run` invokes it for
EVERY rejection leaving the guard — including timeouts and both rejection kinds —
through a single `.catch` that RE-THROWS the original error, wrapped outside the
limiter so it also sees a concurrency rejection raised before the adapter is ever
called. `createResilienceRegistry` wires `onFailure: createPortFailureBridge(metrics)`,
its sixth emission.

**Filtering belongs in the bridge, not at the call site.** The bridge declines to
emit for the three failures already counted, recognising them STRUCTURALLY
(`details.timeoutMs`, `details.breaker`, `details.max` — never message text), so
the four summands stay disjoint. Filtering in `platform/resilience` would put
"which failures are already counted" in a module that is not allowed to know what a
metric is called, six times over. A double-counted error rate is worse than a
missing one: it is a number people quietly stop believing.

Pinned by `src/platform/resilience/__tests__/port-call-failed.test.ts` — ten tests
against a real registry and a real `MemoryMetrics`, deliberately NOT against the
bridge, because the defect was never in the bridge. It asserts both halves: a plain
`Error` from an adapter emits `call_failed` tagged with the port (including through
the real `createGuardedEmbed` wrapper, the audit's exact shape), and a timeout emits
`platform.port.timeout` and NOT `call_failed`. Removing the `onFailure` invocation
turns five named tests red.

The registry's `metrics` header said **FIVE emissions** and is now SIX. D-278 exists
because that count went stale once already.

### D-332 · A wedged SMTP socket had no deadline, and it stalls the alert evaluator, not just signup
**Status:** Active — resilience

`createNodemailerTransport` set no `connectionTimeout`, no `greetingTimeout` and no
`socketTimeout`. nodemailer's defaults are effectively "wait for the OS", which for a
silently dropped TCP connection is minutes. §4 is explicit: "every outbound call has
a timeout. A call without one is a defect."

Two consequences, and the second is the expensive one. Signup and password-reset mail
inherit the hang, holding a connection and a pool slot. And the **alert evaluator
awaits `deliver()` inside `runCycle`**, which its loop awaits — so one wedged SMTP
socket stalls EVERY rule: readiness, pool saturation, backup age. The monitoring goes
dark at exactly the moment something is wrong enough to be mailing about it.

D-319 wrapped that send in `createGuardedMail`, which bounds the CALLER's wait, and
that remains load-bearing. But a race cannot close a socket: the wedged connection
keeps its file descriptor and one of the five `mail` concurrency slots until the OS
gives up. A socket-level deadline is strictly better than an outer race, and having
both is better still — the guard bounds the request, these bound the resource.

**Decision:** all three are set, from the §4 `mail` timeout row rather than from new
environment variables — `connectMs` for the connect and, separately, for the banner
(a server that accepts and never greets is the same outage as one that never
accepts); `totalMs` for socket idleness. No new env var means no new
`env-contract.ts` entry and no way for the socket and the guard to disagree about how
patient this dependency is allowed to be; `container.ts` passes `config.timeouts.mail`
explicitly, and `SMTP_TIMEOUT_DEFAULTS` covers a caller that passes nothing, because
"a call without a timeout is a defect" must not be satisfiable by omission.

`createNodemailerTransport` also gains an injectable transport FACTORY. Without it,
"does this transport carry a socket timeout" is answerable only by opening a socket to
a real SMTP server that hangs, and **no test in this repository opens a socket to an
SMTP server** — the same seam, and the same reason, as `MailTransport` itself. Nine
tests: the exact options handed over, the defaults tied to the §4 row, an explicit
override including a deliberate zero (`??`, not `||`), and two that drive a send which
never settles through a fake applying the `socketTimeout` it was given, on fake timers.
Deleting the three options turns four named tests red — two of them by hanging until
the test timeout, which is precisely the production behaviour being pinned.

### D-333 · Two copies of "which workers are alive", and the correct one had zero callers
**Status:** Active

`readWorkerLiveness` (`platform/jobs/heartbeat.ts`) is the per-worker,
`status <> 'stopped'` liveness query. After D-305 repaired it, it had **zero
callers** — while `scripts/ops/alert-sources.ts` carried a second copy of the same
query with all of them, under a comment saying the shared one "is not reused here
because it currently throws".

The drift is not hypothetical: the duplicate already had two defects the original did
not (`max()` across all rows, so one healthy replica hid every dead one; and no status
filter, so a cleanly stopped worker read as a pulse). Both were fixed in the copy.
Nothing forced the two back into agreement, and nothing would have forced the NEXT fix
into both.

**Decision:** `collectWorkerHeartbeatAge` now reads through `readWorkerLiveness`. The
reference instant is read from the DATABASE (`select now()`) rather than taken from
`options.now`: the age must be measured against the clock the row was timestamped by,
or a few seconds of NTP skew between two containers becomes a "worker heartbeat stale"
page — the old SQL got this right implicitly by doing the subtraction inside Postgres,
and doing it in TypeScript makes the choice explicit. That `now` is normalised through
the same `Date | string` union D-305 was about, because `db.execute` returns wire text
for a `timestamptz`. Zero live rows is still `MAX_SAFE_INTEGER` (the loudest case, not
the quietest), and the minimum beat is taken by `reduce` rather than by indexing the
ordered result — an ordering a future caller of that function is free to change.

The six behavioural heartbeat tests in `tests/ops/alert-sources.test.ts` pass unchanged
against the shared implementation. They are joined by
`tests/ops/worker-liveness-single-implementation.test.ts`, a STATIC drift guard,
because a correct duplicate passes every behavioural test there is on the day it is
written — it is the day after that costs. It scans the file with comments stripped (the
prose quotes the banned SQL to explain why it was wrong; a scan that read the comments
would ban the explanation).

`/health/deps` — the other place `heartbeat.ts`'s header advertises — is still not
wired. It needs a new optional `HealthDeps` member plus container and server wiring, and
is left as the smaller remaining half.

### D-334 · `readChapter`'s narrowing was correct and unprovable — closes D-327 item 2
**Status:** Active — closes D-325's residue

D-325 narrowed practice's chapter read from a bare `catch` to
`if (error instanceof NotFoundError) return null; throw error;` and recorded that it
was **not pinned by a test**, because "the closure is a local inside `buildModules`
with no seam to reach it from". D-327 listed it as residue.

An untestable correct fix is one refactor away from being an untestable wrong one:
`catch {}` and the narrowed version were indistinguishable to the entire suite, which
is exactly how the bare catch survived as long as it did. Before D-325, a pool
exhaustion, a statement timeout, a breaker rejection or a `ForbiddenError` reached the
student as a **404** — nothing propagated, no breaker counted a failure it should have,
no metric moved, and `platform/db` under load presented as a curriculum that had
quietly emptied.

**Decision:** the closure is lifted to an exported `createPracticeChapterReader`,
generic over the actor and the chapter so it stays a pure error-translation rule that
cannot start knowing what a chapter is. This is the D-257 move
(`createFoxyPlanReader`), for the same reason, after the same class of silent defect.
The eight tests in `src/app/__tests__/practice-chapter-reader.test.ts` need no
container, no module and no database. Their value is the NEGATIVE cases —
`DependencyError`, `ForbiddenError`, `ConflictError`, a plain `TypeError` from a bug
inside `content`, and a non-`Error` rejection — every one of which was a 404 before
D-325 and would be a 404 again the moment somebody "simplified" the catch. Restoring
the bare catch turns five named tests red.

---

### D-335 · `GET /me/profile` cannot be the session bootstrap — a signed-in parent gets 403

`02-FRONTEND-IMPLEMENTATION-PLAN.md` §5.5 names one endpoint as the single source of
truth for "am I authenticated, and as whom", and forbids any other route to that
question. It named `GET /api/v1/me/profile`.

That route returns a STUDENT profile for `actor.userId`. Measured, not reasoned about:

| Caller | `/me/profile` |
|---|---|
| Signed-in parent | **403** — `platform/authz` refuses a parent reading a student profile before any row is looked for |
| Signed-in student who has not onboarded | **404** — no `students` row yet |
| No session | 401 |

So the two commonest authenticated states on a cold page load produce two different
error statuses, and §5.6 assigns 403-on-a-GET the treatment "show a no-access state".
A frontend bootstrapping here has to read "you are signed in" out of the one response
the error table says means the opposite — and the failure mode is the worst one in a
cookie-session application: signed-in users bounced to login on refresh.

`studentProfileSchema` also carries no `role` and no `email`, and §5.5 requires the
role in the bootstrap response to choose navigation and theme.

**Decision:** `GET /api/v1/auth/me` on `identity`, the module that owns sessions.
It returns `LoginResponse` — the SAME shape as login, aliased in the contract as
`currentUserResponseSchema` rather than re-declared, so the frontend has one parser
for "who am I" and the refresh path cannot drift from the sign-in path.

A session whose user row has vanished is `UnauthenticatedError`, **never**
`NotFoundError`: the actor came from a validated session, so a missing row means the
account was deleted underneath it. 404 would tell the client "you are signed in and
the thing you asked for is gone" and it would keep the dead session; 401 is what the
whole client already handles — clear the context, clear the cache, go to login.

`tests/integration/session-bootstrap.test.ts` pins all three states with identity AND
learner mounted, which is the only configuration where the contrast is visible; the
identity-only route suite would assert a 404 that is really "route not registered".

---

### D-336 · The frontend proxy cookie check is impossible, and would have worked in development

§5.5 specifies a Next proxy (the 16.x rename of middleware) doing a cookie PRESENCE
check ahead of the layout guard — cookie absent, redirect to login — explicitly as a
user-experience optimisation and explicitly not a security boundary.

It cannot work. `identity.plugin.ts`'s `buildCookieOptions` sets no `Domain`, so the
session cookie is HOST-ONLY to `api.<domain>`. The Next server on `app.<domain>` never
receives it. A presence check there reads "absent" for every signed-in user and
redirects all of them to login.

The dangerous part is that it would pass every local test: in development both apps are
`localhost` and cookies ignore the port, so the cookie IS visible to the Next server.
Correct on every developer machine, broken for every real user — the shape of defect
this log exists to prevent.

**Decision:** no proxy check. Route protection is the layout guard reading the session
context, which §5.5 also requires and which works regardless of cookie scope. The
alternative — widening the cookie to `Domain=.<domain>` — hands it to the marketing
site and every future subdomain, a real security downgrade bought with a skeleton
flash. The cost of the deviation is one render of a skeleton on a cold load.

Recorded at the top of `frontend/src/components/layout/session-gate.tsx`, where
somebody about to "fix the missing middleware" will read it.

---

### D-337 · Backend contracts are GENERATED into the frontend, not imported

§5.1 is absolute: a type the backend returns is defined once, in
`backend/src/shared/contracts/`, and a hand-written mirror on the frontend is
forbidden. The obvious way to honour that is a direct import across the two packages.

It cannot exist. `frontend/Dockerfile` copies `frontend/` and nothing else, so
`../backend/src` is absent inside the image: the production build fails on a path that
resolves perfectly on every developer's machine and in every test run. §5.1 anticipates
this — "if the two packages cannot import from each other directly, generate the types
from the backend contracts as a build step — but there is still exactly one
definition".

**Decision:** `frontend/scripts/sync-contracts.mjs` copies the eight `*.contract.ts`
files, the four constants modules they import, and the `ERROR_CODES` declaration into
`frontend/src/lib/api/generated/`, which is committed. `--check` mode fails on any
difference, and `contracts-drift.test.ts` runs it — so a stale copy, or an edit made
directly to a generated file, fails the build with the command that fixes it.

The test SKIPS when `../backend` is absent rather than failing, because the frontend
image builds from `frontend/` alone and a check that cannot run there would become a
red suite people learn to ignore. CI checks out the whole repository, so the gate is
real where it matters.

The `ERROR_CODES` extraction is deliberately brittle: it throws if the declaration is
renamed or stops ending in `} as const;`. A generator that silently emitted an empty
union would make §5.6's exhaustive switch vacuous — every code would compile as
handled, which is the precise failure the switch exists to prevent.

---

### D-338 · The frontend spacing scale is CLOSED, and Tailwind is silent about violations

§9.1 fixes the scales — spacing at 4·8·12·16·24·32·48·64px, "nothing between". The
config previously EXTENDED Tailwind's defaults, which meant the scale was a suggestion:
`p-5`, `w-64` and `h-80` were all in use and all rendered fine.

Replacing `theme.spacing` rather than extending it makes an off-scale utility not
exist. That is the correct behaviour and it has one hazard: **Tailwind does not warn.**
It emits no class, and the element renders with no padding at all — a visual defect
with no error, no log line and no failing test.

**Decision:** replace the scales AND add `architecture/spacing-scale-only` to
`eslint.config.mjs`, which rejects any numeric spacing utility outside the eight
values. The allowed list must stay identical to `spacing` in `tailwind.config.ts`; two
lists that can disagree produce either a false failure or a missed one.

Switching the rule on immediately found five real breakages the migration had missed,
including `pb-28` on the mobile bottom-navigation clearance — which would have silently
put the last card of every student screen underneath the nav bar.

Layout sizes are NOT spacing and are named instead: `w-sidebar`, `h-panel`,
`w-illustration`, `pb-nav`. A sidebar is 16rem because that is how wide a sidebar is,
not because 16rem is four steps up a padding scale.

The rule inherits D-031's known hole: `staticClassName()` only unwraps a bare literal,
so `className={cx('p-5')}` is not flagged. That matters more here than for the brand
rule — a missed brand literal renders the wrong colour, a missed spacing utility
renders no spacing at all.

---

### D-339 · `queryClient.clear()` in the expiry path was an infinite 401 loop

`SessionProvider.expire` did what §5.5 asks in as many words — "clears the query
cache" — with `queryClient.clear()`.

`clear()` removes EVERY query, including the bootstrap query itself. That query has
a live observer (the provider), so removing it makes TanStack Query refetch
immediately; the refetch 401s; the 401 publishes to `notifyUnauthenticated`; `expire`
runs again. The cycle continues until the tab is closed, and every iteration also
calls `router.replace`, so each navigation supersedes the last and **the login page
never paints**. A browser test caught it doing exactly this: thirty-odd `/auth/me`
requests and an empty body at `/login`.

The jsdom suite did not catch it. Its test asserted "fetched once" and settled before
the second cycle, with a faked router that performs no navigation. That is the
difference the end-to-end tests exist for.

**Decision:** three changes, each with its own reason.

 1. `expire` removes every query EXCEPT the session one
    (`predicate: query.queryKey[0] !== sessionKeys.currentUser[0]`). The cross-user
    leak §5.5 names is about a previous user's profile, practice history and digest —
    none of which is the bootstrap. Leaving the bootstrap in place also preserves its
    401, which is what makes `status` read `unauthenticated` rather than flipping back
    to `loading`.
 2. A one-shot guard (`expiredRef`), re-armed when a bootstrap succeeds. A burst of
    parallel 401s is the ORDINARY case on an expired session, not an edge one.
 3. No redirect at all from a public route. On `/login` a 401 from the bootstrap is
    the expected answer, and redirecting to login from login is a wasted navigation
    that, combined with the clear, was the second half of the storm.

Pinned by `session-provider.test.tsx` ("publishing 401 twice clears and redirects
ONCE") and by the browser test that found it.

---

### D-340 · The frontend CI gates, and which of them are PROVEN

§10.7's rule is the backend's: "each gate is proven by deliberately breaking it once —
a gate that has never failed is not known to work." Eleven gates now exist. Six have
been broken on purpose and observed to fail; five have not, and pretending otherwise
would be worse than not having them.

| Gate | Where | Proven by |
|---|---|---|
| Type check | `npm run typecheck` | routine — it failed twice during this work |
| Lint: boundaries, arbitrary values, brand literals, **off-scale spacing** | `eslint.config.mjs` | ELEVEN real breakages found the moment the spacing rule was switched on, including `pb-28` on the mobile-nav clearance and `size-9`/`size-10` on the avatar and logo |
| Contracts in sync with the backend | `contracts:check` + a test | appended a line to a generated file → red; re-synced → green |
| Deployable isolation | `check:isolation` | added an import of `../../../backend/src` → exit 1, two named violations |
| Coverage floors, per area | `vitest.config.ts` | removed `primitives.test.tsx` → `components/ui` failed at 71% against the 90% floor |
| Contrast, WCAG AA, BOTH themes | `visual.spec.ts` | lightened `--muted` → both dashboards failed |
| Visual regression | `visual.spec.ts` | changed the parent `--brand` → the parent screenshot failed |
| Bundle budgets | `check-bundle-budget.mjs` | **arithmetic only** — ten unit tests over a synthetic `.next`. The gate itself has never run against a real build, because `next build` dies at worker teardown here (open item 33) |
| LCP ≤ 2.5s, TBT ≤ 200ms | `lighthouserc.json` | **NOT PROVEN.** Needs a production build and has never executed |
| axe, zero serious or critical | `foundation.spec.ts` | pre-existing; not deliberately broken during this work |
| Route-group isolation between features | `eslint.config.mjs` | pre-existing; not deliberately broken during this work |

The two unproven-in-anger gates are both blocked on the same two things: a build that
completes on this machine, and CI ever running at all. Both are already the top of
`PROGRESS.md` §2.

**On the coverage floors being per area.** A single global percentage is satisfied by
testing the easy half: 90% overall with every primitive untested and every pure
function exhaustively tested is a number that bounds nothing. The globs are disjoint
on purpose — Vitest applies one glob's thresholds to the files it matches, and
overlapping patterns make it ambiguous which floor applies. Two areas the plan's table
does not name (`lib/api`, `lib/session`) are held at the hook floor rather than left to
a default, because the error table and the bootstrap are what every screen depends on.

---

### D-341 · The language axis of visual regression does not exist yet, and is not faked

§10.7 specifies visual regression over two journeys x two breakpoints x two languages x
two themes. Three of those axes are real today: the breakpoints are the two Playwright
projects, the themes are the two route groups (`data-theme` is set by the layout, so
`/student` IS purple and `/parent` IS orange), and the journeys are the two dashboards.

There is one dictionary, in English. Build-order step 5 has not been done.

**Decision:** run the three axes that exist and add the fourth when the Hindi
dictionary lands, rather than adding a `?lang=hi` run now. A Hindi run today would
screenshot the same English strings and report a green gate for the exact property
§10.7 says the axis exists to catch — "a Hindi string overflowing a button". A gate
that cannot fail is worse than a missing one, because it is counted as coverage.

A companion test asserts the two themes really do resolve `--brand` to different
values. Without it, "both themes" could quietly become one theme tested twice, and
every contrast assertion in the file would be half a check.

**On baselines.** Playwright names snapshots per platform and it is right to: font
hinting and anti-aliasing genuinely differ. The committed baselines are `win32`. The
first Linux CI run writes its own, and they must be committed from that run's artifact
before the gate means anything in CI.

### D-342 · The Dialog is hand-written rather than native `<dialog>`

jsdom implements neither `showModal()` nor the top layer, so a native modal's focus
trap could only ever be tested against a polyfill — and the trap IS the component.
A test that exercises a polyfill proves the polyfill works.

**Decision:** hand-write the dialog, with an explicit focus trap, a restore-focus-on-close
step and an Escape handler, all of which the test suite drives directly. Revisit when
the test environment implements the top layer, not before.

### D-343 · A rejected `onConfirm` must not escape `ConfirmDialog`

Found by the component suite in the same session that wrote it. A confirm handler that
rejected left an unhandled promise rejection — a console error in the user's browser,
under a dialog that had silently re-enabled itself with no explanation of why nothing
happened.

**Decision:** the dialog awaits the handler inside a `try`/`finally`, re-enables in the
`finally`, and lets the rejection reach the caller's own error boundary rather than the
window. A destructive action that fails must say so; re-enabling a button is not a message.

### D-344 · Field errors come from the generated request schema, not from the 400

§5.6 requires a 400 to "map onto the form, never a page-level error". THE BACKEND CANNOT
SUPPLY THAT MAPPING. `AppError.toClientPayload()` sends `{ error: { code, message } }`
and deliberately drops `details`, so a validation failure arrives as one prose sentence
with no field attached to it.

**Decision:** validate with the GENERATED request schema before the request goes out, and
map `(field, Zod issue)` onto a dictionary key. The schema is the backend's own, copied by
`contracts:sync` and drift-tested, so the rules are identical by construction rather than
by discipline. A 400 that survives it means client and server have drifted — a defect, not
a typo — and renders as a form-level message.

**Rejected:** extending the wire envelope with per-field details. That is a backend
contract change to solve a problem the frontend already has the information to solve, and
it would put user-facing prose on the wire, which §5.6 forbids rendering anyway.

### D-345 · A 401 from `POST /auth/login` is a credential verdict, not an expired session

`identity.service.ts` answers a wrong address and a wrong password identically, with
`UnauthenticatedError` — 401 `UNAUTHENTICATED`, the same status and the same code as an
expired cookie. `providers.tsx` routes every 401 into `notifyUnauthenticated()`, so a
wrong password cleared the query cache and reported a sign-out on the sign-in screen.

**Decision:** `ApiError` carries the request path, and the 401 handler skips
`authPaths.login`. The path is the only thing that distinguishes the two cases; status,
code and body are identical by design. The constant lives in `lib/api/paths.ts` because
`providers.tsx` is app-level infrastructure and must not import a feature to learn a path.

### D-346 · `?next=` is untrusted, and "starts with /" is not the check

`?next=` arrives in a URL anyone can send to anyone. `//evil.example/login` starts with
a slash and is protocol-relative — a browser reads it as another origin. On the one
screen where a password has just been typed, that is an open redirect.

**Decision:** honour only a value that starts with `/` and does NOT start with `//`.
Tested against `//`, `https://`, `javascript:` and null.

### D-347 · The verify screen has no code field, because no code endpoint exists

The presentational screen asked for a six-digit verification code. Verification is
`GET /api/v1/auth/verify?token=` and always has been: an opaque token in the link the
signup email carries. There has never been an endpoint that accepts a six-digit code.

**Decision:** the screen reads the token from the URL that opened it, verifies once
(guarded by a ref, because React double-invokes effects in development and verification
CONSUMES the token — the second call would paint "expired" over a success), and offers
the resend affordance §5.6 requires. Its only input is an email address, because
`/auth/resend-verification` needs one and the person holding a dead link is not signed in.

### D-348 · Build in the container; a Windows-host build is not the target

Open item 33 recorded `next build` dying at worker teardown (`kill EPERM`) on Windows,
with the bundler ruled out and the worker pool named as the next avenue. The next avenue
was neither.

**Decision:** stop treating a Windows-host build as the target. `frontend/Dockerfile`
already builds on `node:22-bookworm-slim`; the same source compiles cleanly there and
produces `.next/standalone` — the artefact item 33 recorded as never written. Extract
`.next` from the `build` stage with `docker create` + `docker cp` for the bundle gate,
and `docker run -p 3000:3000` for Playwright and Lighthouse.

**What it cost to not do this sooner:** the browser suite had never run. The first run
found two colour tokens failing WCAG AA, horizontal overflow on every auth screen at
360px, and a bundle gate measuring a file the framework no longer emits.

### D-349 · Colour tokens are checked against their own tint, not only against the surface

The token block asserted every tone against `--surface` and against white. The badges are
`bg-<tone>/10 text-<tone>` — a tone on a 10% tint of ITSELF — and that pairing was in no
assertion. `--success` measured 5.02:1 on white and 4.38:1 on its tint; `--warning` 4.92:1
and 4.32:1. Every "Strong evidence" label on both dashboards was a serious WCAG AA
violation while the tokens looked compliant.

**Decision:** darken to `22 101 52` (6.14:1) and `133 77 14` (5.90:1), and state the tint
case in the token block so the next person adding a tone knows which pairings matter.
`--danger` (5.45:1) and `--info` (5.72:1) already cleared it and are untouched — the fault
was two tones sitting just above the floor on white and just below it on the tint, not a
palette that was too light. The tint moves with the token, so both figures are computed
from the new value rather than assumed from the old one.

### D-350 · A lockfile generated on Windows cannot install on Linux

`npm ci` failed in the image with EUSAGE, naming `@emnapi/core` and `@emnapi/runtime` as
missing. Their entries were absent because the lock was generated on Windows, where the
optional `@img/sharp` variant that pulls them in never installs — so the tree was recorded
for one platform only. The frontend image had therefore never built anywhere, and
`frontend-ci.yml` would have failed on the same line the first time CI ran.

**Decision:** regenerate with `npm install --package-lock-only` INSIDE
`node:22-bookworm-slim`, which is the only place the Linux-only optional dependencies
resolve, and verify both directions — `npm ci` completes in the image, and
`npm ci --dry-run` still resolves on Windows. Any future dependency change needs the same
treatment; a lockfile written by a Windows `npm install` is not portable.

### D-351 · A completed Foxy turn marks the transcript stale without refetching it

The Foxy screen renders two sources as one list: the stored transcript from
`GET /foxy/sessions/:id`, and the live messages `useFoxyStream` holds. The hook
invalidated the transcript query on completion — correct in intent, so a reload shows what
the server stored — and the refetch returned the very turn still held in memory. Every
finished answer would have appeared twice.

Deduplication is not available as a fallback: a user message carries NO server id at all,
ever, and matching on text collapses a student who asked the same question twice. Freezing
the transcript at first load is the obvious alternative and is refused by two lint rules
that are both right — `react-hooks/refs` (a ref read during render) and
`react-hooks/set-state-in-effect` (the cascading render the effect spelling costs).

**Decision:** `invalidateQueries({ refetchType: 'none' })`. The cache is marked stale and
the mounted screen is left alone, so the two halves cannot overlap and the next MOUNT
reads the server's version — which is the property the invalidation was for. A rule
refusing both spellings of an idea usually means the idea is in the wrong file; the
duplication was created in the stream hook and is fixed there.

### D-352 · The open Foxy conversation lives in the URL, not in component state

§7 point 5 asks that "a page refresh shows the same history". The stored transcript alone
cannot deliver it: with the session id in `useState`, a refresh loses which conversation to
load and returns the student to the start panel with their turns sitting on the server,
unreachable.

**Decision:** `/student/foxy?session=<id>`, written with `router.replace` on creation.
`replace` and not `push`, because the start panel and the conversation are one screen in
two states — a back press should leave Foxy rather than land on a panel that opens a second
session nobody asked for. The parameter is also what makes the conversation survive the two
tabs a phone user ends up with.

### D-353 · "The conversation could not be started" is not "the answer stopped"

`foxyErrorMessage` mapped every generic treatment to one sentence, and the Foxy screen has
TWO requests that fail generically: the turn, and `POST /foxy/sessions`. A failed start
rendered "Something interrupted the answer. Try asking again." — telling a student
something did not finish when nothing had started.

**Decision:** an optional `fallback` translation key, named by the caller. It applies ONLY
where the treatment has no specific copy of its own, so a rate limit or a refusal still
reads correctly from either screen. Found by the integration test for the start-failure
path, which is the one place the two requests are visible together.

### D-354 · The evidence label takes the wire code, and is translated

`EvidenceLabel` took `LearningEvidence` — a hand-written union of English strings in
`src/types/` — and rendered the value directly. Two faults, and the second one shipped.

§12 forbids "a hand-written type for data the backend already defines", and
`EVIDENCE_LABELS` is generated from the same constant the database CHECK is built from.
Two vocabularies for one closed set is one drift from a screen that cannot render a label
the server sends.

**And the label was never translated.** The English sentence WAS the value, so a Hindi
reader saw "Strong evidence" on their own progress and on their child's — on the screens
§8 cares most about, and invisible to anyone working in English.

**Decision:** the component takes `EvidenceLabel` from the generated constants, maps it to
a dictionary key through a `Record<EvidenceCode, TranslationKey>` (a missing entry is a
type error), and `src/types/learning-evidence.ts` is deleted. Both fixture callers move to
codes. The four visual baselines this changes were already stale (open item 43).

### D-355 · Weakest-first is stated, because the generated order is not an ordering

The chapter step bar fills to a chapter's evidence rank. `EVIDENCE_LABELS` is generated and
its order is the DECLARATION order of a closed set — `strong` first — which is not an
ordering of strength. A bar built straight from it fills backwards: "Not assessed yet"
lights every segment and "Strong evidence" lights one.

**Decision:** `EVIDENCE_ASCENDING` in `features/progress/lib`, derived by sorting the
generated union through a `Record<EvidenceCode, number>` so a fifth label added upstream is
a type error rather than a silent rank zero. The bar stays `aria-hidden`: the LABEL is the
information, and §9.1 forbids the percentage a filled bar is one refactor from becoming.

### D-356 · Ownership of a wire call follows the caller, not the URL prefix

`getPracticeProgress` and `getPracticeHistory` were written in `features/practice/api`
because their paths are `/practice/…`. The progress feature then imported them and
`architecture/no-cross-feature-imports` refused — and the first instinct was to argue with
the gate in a comment explaining why this case was fine.

It was not fine. Practice's own screen calls mission, session, answer and submit; it never
reads progress or history. Both readers of those two endpoints are the progress screen.

**Decision:** the two functions move to `features/progress/api`. Everything genuinely
shared already was — paths in `lib/api/paths`, schemas generated, cache keys in
`lib/api/query-keys`, which is how practice's submit mutation invalidates what the progress
feature queries without either importing the other.

### D-357 · Practice renders "4 of 6", never "67%"

`SubmissionResult` carries `scorePercent` and the summary deliberately does not read it. A
session score and a mastery percentage are indistinguishable to a child — both are a number
out of a hundred describing them — and §9.1 forbids the second. "4 of 6 correct" is a fact
about six questions and cannot be read as a verdict. A test asserts the string `%` never
reaches either screen.

The same section covers the client-supplied timer. `timeSpentMs` is clamped into the
contract's range rather than sent raw: a backwards device clock (NTP, a timezone change)
gives a negative and a tab left open over lunch gives hours, and either one 400s an answer
the student would then lose over a number they never saw. The clamp is safe because the
server does not trust the figure anyway — `submitSession` bounds the claimed total by its
own wall clock before averaging.

### D-358 · The hint ladder is contracted, unrouted and unpopulated

`practice.contract.ts` defines `hintQuerySchema` and `hintResponseSchema`;
`practice.routes.ts` registers nothing that serves them. The content is absent too —
`hint_level_1..3` are NULL on all 3,791 source questions (open item 13).

**Decision:** no hint affordance on the practice screen, and the gap is recorded at
`practicePaths` rather than stubbed. A hint button today would 404 to fetch content that
does not exist; a disabled one would advertise a feature with no delivery date. The
contract half is not deleted — it is the right shape for when generation lands.

### D-359 · The child-visibility notice is rendered before every branch

§10.4's row for the parent feature ends with the only requirement in that table written
in bold: "the child's visibility indicator is ALWAYS present". The contract makes
`visibility` non-optional for the same reason and says it — "an optional field is a field
a client can forget to render".

**Decision:** the notice is rendered above the source/empty/populated fork in
`TranscriptPanel`, not inside any of them and not after an early return, so every path
through the component passes through it — including the two paths that render no
conversation at all. A parent who looks, sees nothing and is told nothing about what they
were looking at is the exact case the requirement exists for. Tests cover the empty and
`not_yet_available` paths specifically for this.

`childIsTold: false` is rendered in `warning`, from the server's own bilingual
`disclosure` sentence. A parent with permission over a child who does not know is the
shape this product refuses to be, and it is a promise the product makes rather than copy a
screen invents.

### D-360 · `not_yet_available` and an empty transcript are different sentences

The contract keeps `source: 'not_yet_available'` apart from `sessions: []` so "a parent
shown an empty screen deserves to know which". Collapsing them into one empty state would
tell a parent their child has never asked Foxy anything when the truth is that nobody can
see it yet — a false statement about their child, produced by a client being tidy.

**Decision:** two states, two sentences, and the unavailable one says explicitly that it is
not the child having asked nothing.

### D-361 · A 403 means two different things to a parent, and the method tells them apart

On a GET it is almost always the CHILD having revoked the link — a right the product gives
the child and the parent cannot override. On the revoke POST it is usually a CSRF origin
rejection, because the backend returns 403 before 401 on state-changing requests.

**Decision:** `parentErrorMessage` reads `no-access` as a STATE — "only your child can give
it again" — with no retry offered, since §5.6 notes a 403 will not become a 200 and a retry
button would invite a parent to hammer a refusal their child chose. `action-blocked` reads
as a stale page. Telling a parent their access was withdrawn when it was not would be a
false alarm about their own child.

### D-362 · The parent dashboard is four queries, not one aggregate

Snapshot, digest, transcript and consent are four endpoints answering four questions with
different costs and different failure modes.

**Decision:** four queries, each panel owning its own loading and error. A page-level gate
would be as slow as the slowest and as fragile as the weakest — and the transcript, the
biggest and the one a parent looks at least, would hold up the counts they came for. The
property that matters: a failed panel still leaves the CONSENT controls reachable, which is
the one part of this page a parent must always be able to use. Asserted by a test.

Revoking removes the child's three data queries from the cache rather than invalidating
them — they are exactly the data the parent just gave up, and refetching would fire three
requests designed to 403 — and invalidates `children`, because the link leaves the approved
set.

### D-363 · The parent fixtures are deleted, not left beside the real screen

`/parent` rendered a `ChildSummary` built from a hard-coded child, a hard-coded parent name
and two invented "recent updates". Everything it stood in for is now on the wire.

**Decision:** the page renders the live dashboard and `child-summary.tsx` and its test are
deleted. A sample dashboard beside a real one is a screen nobody can tell is lying — and
`parent.greeting` took a name the product no longer invents, so it becomes `parent.title`.
The student dashboard is still fixtures (open item 45) and is now the only one.

### D-364 · The plan catalogue is served, because a price is not a client's to know

`PLANS` lives in `modules/billing/domain/plans.ts`, which the frontend cannot import. Before
`GET /billing/plans` existed, a billing screen had exactly two options: hard-code
"₹299 / month", or show nothing.

A hard-coded price is not the same class of defect as a hard-coded button.
`GET /foxy/capabilities` is served so a client cannot offer an action the server does not
implement — a broken button. A client with its own copy of a PRICE eventually advertises
one figure and charges another, which is a chargeback and a consumer-protection problem.

**Decision:** a new route, reading `purchasablePlans()` — the same table `findPlan` reads on
the checkout path, so the figure quoted and the figure charged cannot drift. `free` is
absent: it is `purchasable: false`, what somebody already has rather than something to buy.
No service call and no access decision — the catalogue is public commercial information and
sits behind `authenticated` only because the screen that renders it does.

`amountMinorUnits` is PAISE and an integer everywhere except the moment of display. Money in
a float is how ₹299.00 becomes ₹298.99999999999994.

### D-365 · One unknown entitlement must not take down the whole pricing page

`planSummarySchema.features` is `z.array(entitlementFeatureSchema)` — a closed enum — so
validating the catalogue against it made a SINGLE unrecognised feature reject the entire
response. The screen then rendered "plans could not be loaded", and the cause was the
backend having added an entitlement. Found by a test that fed it `school.reporting`.

That is the failure §7's frame parser already refuses for Foxy in as many words: an additive
backend change must not become an outage for everyone who has not reloaded. It matters more
here, because a client that cannot render the catalogue cannot sell anything.

**Decision:** the catalogue is parsed with `features` widened to `z.array(z.string())` and
`PlanCard` drops the ones it has no words for. Everything that decides money — `code`,
`amountMinorUnits`, `currency`, `periodDays` — stays on the generated schema and stays
strict. Leniency is confined to the half that is presentational.

A code rendered raw would be worse than a missing bullet: "practice.unlimited" in a feature
list reads as an unfinished page, on the screen where trust matters most.

### D-366 · The checkout URL is checked before the browser follows it

`checkoutUrl` is a plain `z.string()` on the contract, not `z.string().url()`, so the schema
does not establish that it is safe to navigate to. Every other external link in the product
is a constant; this one arrives at runtime and is followed with the customer's payment
intent behind it.

**Decision:** `isFollowableCheckoutUrl` — absolute, and `http:` or `https:` only. Defence in
depth, since the value comes from our own server, but the cost is one function and the cost
of being wrong is a `javascript:` URL executing in the session of somebody who just pressed
a button labelled "pay". A provider response passed through, a misconfigured
`RAZORPAY_PLAN_IDS`, or a future adapter that builds the string differently are all ordinary
ways for a non-http value to arrive. A refusal shows a failure that says NOTHING WAS
CHARGED; doing nothing silently would leave somebody pressing "pay" with no response.

### D-367 · A 409 on subscribe means "you already have it", never "try again"

`createSubscription` refuses when a live subscription already exists. The honest reading is
that the customer already has what they were trying to buy — a second tab, or a back button
after a completed checkout.

**Decision:** the 409 renders as "You already have an active plan. Reload this page to see
it." A generic "something went wrong, try again" invites them to retry, and the thing they
would be retrying is a payment. A 400 gets the same treatment one step down: the plan code
came from the SERVED catalogue, so a rejection means the plan was retired between the page
loading and the button being pressed — reloading is the actual fix, not correcting a field
nobody filled in.

`pending` is rendered as "waiting for payment" and never as active. A subscription is created
in `pending` and grants nothing until the webhook confirms; a screen that read "subscribed"
at checkout would tell somebody they had bought something before any money moved.

### D-368 · A school-paid seat is shown no price and no cancel button

The contract carries `payer.kind` because such a student "must not be shown 'you will be
charged ₹299'", and because without the field a client would have to infer who pays from the
role.

**Decision:** `payer.kind === 'school'` hides the catalogue entirely — a price list below
their status is that forbidden sentence in a different font — and hides the cancel control,
because ending an institutional contract is not this screen's to offer and the attempt would
produce a refusal the student could do nothing about.

The screen ships under `(parent)` for the same unresolved question: the contract says
"nothing in this file says a parent pays". A student on a school-paid seat therefore has
nowhere to see that fact yet, recorded as an open item rather than answered by adding a
fifth item to a mobile bottom navigation on a guess about who pays.

### D-369 · The browser suite's target is an environment variable, and that one line unblocked it

`playwright.config.ts` had `baseURL: 'http://127.0.0.1:3000'` as a literal, and port 3000 on
this machine is held by the backend's own `api` container. So the only way to run Playwright
was to stop the backend — which the suite needs the moment it tests anything past a static
page. That is why five screens (Foxy, practice, progress, the rebuilt parent dashboard,
billing) had never once been opened in a browser.

**Decision:** `PLAYWRIGHT_BASE_URL` overrides the target and `PLAYWRIGHT_NO_SERVER=1`
suppresses the managed `webServer`, which would otherwise start a dev server alongside the
container under test — `reuseExistingServer` cannot help, because it probes the URL it was
given and that URL is now somebody else's. Defaults unchanged, so CI does not move.

`tests/e2e/support/session.ts` carried the same literal for the language COOKIE, and a
cookie is set FOR A URL: it was being planted on an origin the browser never visits, so every
Hindi assertion in a redirected run would have silently tested English.

**What the first run found**, immediately: a stale heading assertion (the parent fixtures were
deleted in D-363 and this spec still expected "Welcome back, Ananya" — broken in that commit,
uncatchable until now), and the touch-target defects in D-370.

### D-370 · The 44px rule is measured on the activation area, and it found three real defects

§12: "every interactive element is at least 44 by 44 pixels". The new responsive spec asserts
it against what the browser laid out, not against the presence of a `min-h-control` class — an
off-scale utility emits nothing and the element renders at its user-agent size, which is how
the closed token scale produced eleven silent breakages when the spacing rule was switched on.

**Decision on what to measure:** a control wrapped in a `<label>` is measured by the LABEL.
A checkbox is 16×16 and always will be — that is the user-agent control — and what a finger
hits is the label, because clicking it activates the control. Measuring the input alone
reported six failures on the onboarding form and would have demanded enormous checkboxes,
which is neither the standard nor what the rule protects. An UNWRAPPED 16×16 control still
fails, and every button and link is still measured directly.

**Three genuine violations, all found on the first run:**

- the product-shell wordmark link, 129×36, on every authenticated screen
- the auth-shell wordmark and "change role" links, 43 and 37 tall
- the onboarding LANGUAGE radios, whose labels were 68×21 and 50×21 — the subject checkboxes
  beside them already carried `min-h-control` and these did not

All three are navigation or form controls on a phone, and none was visible to anybody
reading the code.

### D-371 · The production image build depends on reaching Google Fonts

`next/font/google` downloads at BUILD time, so `docker build` fetches from Google inside the
container. Two builds in this session failed with twelve `Can't resolve
'@vercel/turbopack-next/internal/font/google/font'` errors and succeeded unchanged on retry —
a network blip, not a code defect.

Recorded rather than fixed, because the fix is a decision: self-host the two families
(`next/font/local` plus the woff2 files committed) and the build becomes hermetic and
offline-capable, at the cost of carrying font binaries in the repository and updating them by
hand. Until then a deploy can fail for a reason nothing in the diff explains, and CI — which
has never run — will meet it eventually.

### D-372 · Changing a password requires the current one, even with a live session

`POST /auth/change-password` did not exist: a signed-in user who wanted to rotate their
password had to go through forgot-password and wait for an email.

**Decision:** the endpoint requires `currentPassword` and verifies it against the stored
hash. A cookie proves the browser signed in at some point; it does not prove the person at
the keyboard is the account holder, and shared family devices are the normal case here —
the entire parent-child link design assumes them. Without the check, whoever finds the
laptop open locks the owner out.

EVERY session is revoked, the caller's included, and the route clears the cookie. Sparing
the current one would need the raw session token threaded into the service — putting a live
credential into a signature that never needed one — and the security argument runs the other
way anyway: people change passwords BECAUSE they believe someone else has one, and a change
that leaves the other party signed in has not done the thing it was asked to do.

Rejecting a new password equal to the current one uses `hasher.verify` against the stored
hash rather than comparing the two inputs, because Argon2 salts every hash. Reporting
success while changing nothing is the worst possible answer to somebody who believes they
have just secured their account. Rate limit is 5/hour keyed by USER, not IP — the endpoint
is an online guessing oracle, and an IP counter would punish everyone behind a school's
single address.

### D-373 · Guardian linking is code + OTP, and the student-approval model is removed

The old flow was: student issues a code, parent submits it, the link sits `pending`, THE
STUDENT APPROVES. It could never complete. **No endpoint exists through which a student can
discover a pending link's id**, so `POST /links/:id/approve` was unreachable and every
parent stayed pending forever. It surfaced only when the journey was walked end to end — the
unit tests passed throughout, because each half worked in isolation.

The already-working product solves it differently, and better. Its shape was adopted:

- the code hand-off IS the consent — a student reading their code aloud is a deliberate act
- the second factor protects the PARENT'S account: an OTP to their own verified address, so
  a code overheard in a classroom is not enough
- the link is created `approved`; there is no pending state on this path

**Decision:** `POST /links/request-otp` and `POST /links/redeem` replace `POST /links/submit`
and `POST /links/:id/approve`, which are deleted. Two reachable consent models would be
worse than one broken one — somebody would eventually wire a screen to the wrong pair.
`pending` REMAINS a valid status and every read still denies on it, because rows written by
the old flow exist in live databases and a guard that stopped recognising them would
silently grant access.

Controls, matching the proven implementation: OTP stored as `sha256(otp‖challengeId)` and
never in the clear; constant-time compare; ten-minute life; five wrong attempts then an hour's
lock; **a resend replaces the secret but never resets the attempt counter**, which is the
obvious way around any attempt cap; sixty-second resend cooldown; the address comes from the
account and never from the request.

`POST /links/request-otp` RETURNS AN IDENTICAL RESPONSE whether or not the code matched a
student, and sends no email when it did not. The endpoint takes a six-character code, so a
truthful "no such student" turns a 31^6 search into an enumeration of children.

### D-374 · Link codes no longer expire

A fifteen-minute TTL required the parent to be standing beside the child while the code was
generated. That is not how a code reaches a parent: it is read out on a phone call, or sent
home on a slip.

**Decision:** `link_codes.expires_at` becomes nullable, NULL meaning "does not expire". The
code stays single-use and one-per-student; what bounds somebody who merely LEARNS a code is
now the OTP to the parent's mailbox rather than a countdown. A non-null value still expires,
so every existing row keeps its meaning and the repository's expiry test still passes.

**This broke `findActiveLinkCodeForStudent` and an existing test caught it.** The predicate
was `expires_at > now`, which is NULL for a persistent code — not true — so the student's own
screen could not see their own code and would have minted a replacement on every render. The
fix is an explicit null branch, written out rather than optional-chained, because
`row.expiresAt?.getTime() <= now` is `undefined <= number`, which is `false`, which would
also accept the row — by accident, for the opposite reason.

### D-375 · A status report that distinguishes wired, populated and real

`npm run ops:status` drives the API as a signed-in student and parent, then reports content
coverage from the database.

**Why it exists:** "is it working?" has three answers that get confused. WIRED — the route
answers. POPULATED — it returns rows rather than an empty list. REAL — the thing behind it is
not a deterministic fake. A green health check answers only the first, which is exactly how
D-226's mail outage stayed invisible: `mail.send` resolved, every probe was green, the
breaker never opened, and nothing was ever delivered.

**What its first run found**, none of which any existing check reported:

- `questions` has NO `hint_level_*` columns and NO `question_hi` column. Not NULL — ABSENT.
  The contract sends `hintLevelsAvailable` on every question, so it is an array that can only
  ever be empty, and practice cannot be taken in Hindi at all. `PROGRESS.md` recorded both as
  "NULL, needs generation"; they are a missing migration.
- 639 chapter concepts with full explanations across 129 chapters, and NO API SERVES THEM.
- 20 of 4,686 corpus chunks still have no embedding and are invisible to Foxy's search.
- 0 of 2,741 questions tag a misconception, so `signals` and the parent digest have nothing
  to name.

It also found two things about itself worth keeping: a POST carrying `content-type:
application/json` with no body is answered **500 rather than 400**, and signup's 3/hour
per-IP limit is spent two at a time by the probe — reported as DENIED rather than crashed,
because a working rate limiter must not read as a broken API.

### D-376 · GET /content/chapters/:id/concepts — the study walkthrough

`chapter_concepts` has held 639 rows since the corpus import — every one with an English
explanation, 629 with Hindi — and no endpoint served them. The content was written,
imported, indexed and stranded.

**Decision:** one route returning the chapter AND its concepts together, because a screen
that rendered concepts without the chapter would show an unnamed list for the length of a
second round trip.

Three things the ordering forced. `concept_number` is nullable and the source repeats
values, so it cannot be trusted alone: Postgres sorts NULLs FIRST ascending, which would
open a chapter's walkthrough on whichever concepts the import failed to number. It is
`asc nulls last`, with `id` as a tie-break so the order does not change between two
requests — a walkthrough that reshuffles under a student mid-chapter is worse than one in an
imperfect order. Both are asserted.

A chapter with NO concepts is a 200 with `[]`, not a 404. Ten of the 137 have none, and that
is content missing rather than a chapter missing. `getChapter` runs FIRST rather than in
parallel, so a withdrawn chapter 404s before the concept read and timing cannot leak its
existence. `commonMistakes` is narrowed rather than cast: the column is `jsonb NOT NULL
DEFAULT '[]'`, but jsonb can hold anything, and a malformed row should cost one concept its
list rather than the whole chapter a 500.

### D-377 · The SSE route lost its CORS headers, and every browser blocked Foxy

`POST /foxy/sessions/:id/messages` HIJACKS the reply so it can push frames to the socket.
`@fastify/cors` sets its headers in an `onSend` hook, and a hijacked reply never reaches
`onSend`. So the product's ONE streaming endpoint went out with no
`access-control-allow-origin` while every other route had one, and **every browser discarded
every Foxy turn before a single frame reached the application.**

All 3,220 tests passed throughout. `app.inject` does not enforce CORS and does not surface
headers written straight to the raw socket; curl does not enforce CORS either; and every
backend test is one or the other. It took driving the real UI against the real API — the
exact blind spot §5 of PROGRESS.md names as "the wire boundary is the one thing three audits
could not reach".

**Decision:** an `onRequest` hook in `plugins/cors.ts`, scoped to the SSE path, sets the
headers on `reply.raw`. Node MERGES headers set that way with the ones passed to
`writeHead`, so they survive the hijack. The hook is scoped so no ordinary route gets a
second copy, and the allow-list stays in `plugins/cors.ts` — the route must not learn it, or
there would be two places deciding which origins may read.

**And a socket-level test, the first in the repository.** `foxy.sse-socket.test.ts` listens
on an ephemeral port and speaks real HTTP, because the assertion cannot be made any other
way. It also asserts the negative — an origin that is not allow-listed gets no headers —
since a hook that echoed whatever arrived would be the reflected-origin policy
`plugins/cors.ts` explicitly refuses to be.

Writing it cost one wrong turn worth recording: the CORS allow-list and the CSRF origin
allow-list are DIFFERENT lists (D-082 split them deliberately), and asserting against
`HARNESS_ORIGIN` — which is `APP_URL`, not `CORS_READ_ORIGINS` — makes a correct
implementation look broken.

### D-378 · Study is subject → chapter → concept, in the URL

Foxy's start panel was the only way into the product's content, and it asked for a mode and
a subject from two `<select>`s. That lost three things and broke one.

Lost: the back button, a link somebody can send, and a screen that reopens where it was
left. Broke: the subject `<select>` defaults to `SUBJECTS[0]`, which is MATHEMATICS, so a
student asking a science question in a fresh conversation had it retrieved against the maths
corpus and got an abstention. Confirmed in the trace — `subject=mathematics, chunks=0,
abstain_reason=below_threshold`.

**Decision:** `/student/learn?subject=science` and `/student/learn/[subject]/[chapter]`,
matching the mental model the working product uses — Subjects → Chapters → Read → Practise.
Both URL segments are validated server-side: an unknown subject and a malformed chapter id
are 404s, because a path segment is user input exactly as a query string is.

"Ask Foxy about this" carries `?subject=`, which `StartPanel` takes as `initialSubject`. The
subject is now known rather than guessed on the path a student actually takes.

**The concept position is component state, not the URL.** A half-read chapter is not worth
linking to, and putting it in the URL would put every "next" press into history — leaving a
seven-concept chapter would mean pressing back seven times.

**One concept per screen.** A chapter averages seven; rendering all seven is a page a
student scrolls past, and rendering one is a thing they finish. The last one offers PRACTICE
rather than a dead end, because the pedagogy is read-then-practise and a chapter that ends
with nothing to press ends the session.

The chapter NUMBER leads and the title follows: students are told "do chapter 6", and 63 of
the 137 titles are placeholders the number has to carry.

### D-379 · A profile you can edit, and a header that reads it

`PATCH /me/profile` shipped with the learner module and no client ever called it. A student
chose a display name, a grade and a preferred language once, during onboarding, and could
never change any of them again. The contract was complete; the screen did not exist.

**Decision:** `/student/profile`, reached from the student's own name in the header rather
than from a sixth navigation item — mobile navigation is five columns wide, and item 47
records the last time a sixth was refused on a guess about who a screen belongs to.

**It sends the difference, not the form.** Correcting a spelling sends `{ displayName }`
alone. Posting every field on every save rewrites values nobody touched, and that write is
indistinguishable in the audit trail from a student who deliberately changed their class.
The same fact disables the button while nothing differs: the contract refuses an empty
PATCH, so there is no request to make.

**A 404 is not an error on this screen.** It means onboarding was never finished — one
click away — so it renders the empty state pointing there, with no retry, because retrying
a 404 produces the same 404.

**`ProductShell` gained an `identity` SLOT, not a name.** The shell is a server component and
the session cookie is host-only on `api.<domain>`, so nothing about the signed-in user can be
read there (the same fact that killed the Next proxy check `session-gate.tsx` records). A client
component supplies it, `src/components/**` may not import a feature, and the layout — which
may — passes it in. It shares the profile screen's query key, so the header shows the new
name the moment a save lands, with no second fetch.

The language field carries a hint, because the product has two language settings and this is
only one of them: the header switch sets the language of the INTERFACE, on this device, in a
cookie; this field sets the language the SERVER answers in. Neither is wrong, and a screen
that did not say which was which would be.

### D-380 · The student dashboard is live, and the week strip is gone

`/student` was the last fixture screen and the first one a client saw after signing in:
`sampleProgress`, a learner called Aarav, a chapter called "Fractions in everyday life", and
a week of five squares with four filled.

**Decision:** three reads — `/practice/mission`, `/practice/progress`, `/me/profile` — of
which only the mission gates the render. The ledger fills tiles and one sentence and arrives
when it arrives; the profile supplies a name, and its absence produces "Hello" rather than
somebody else's name.

**The week strip was deleted rather than wired.** No endpoint carries a streak. Practice
history has sessions and dates, and turning those into "four learning days" is a product
decision nobody has taken — inventing one in the client to keep a decoration is exactly how
the fixture arrived.

**"Where you left off" is the newest `lastPractisedAt`,** which `/practice/progress` has
carried since it was built. It links to `/student/practice` and not to a chapter-specific
URL, because that route takes no chapter parameter; a link that looks deeper than it is
would be the next fixture to remove.

**The dashboard owns its own wire calls** rather than importing practice's or the profile's —
`no-cross-feature-imports` asking the D-356 question again, answered the same way: ownership
follows the caller. Paths, generated schemas and cache keys are shared, so the duplication
costs nothing at runtime and the dashboard and the progress screen resolve to one fetch.

`student.greeting` lost its time of day: "Good afternoon" was rendered at every hour to
every user.

### D-381 · Saving a language switches the interface, and only in that direction

D-379 left the profile's `preferredLanguage` and the header's language switch independent, and
said so in a hint: this field sets what the SERVER answers in, the switch sets what the
INTERFACE is written in. That was defensible on paper and indefensible in front of a student —
choosing "हिन्दी" on a screen called "Your profile" and watching the product stay in English
reads as a save that did not work.

**Decision:** a successful save calls `setLanguage` with the language in the RESPONSE, so the
interface follows what was actually stored. A refused save changes nothing, which the tests
pin from both sides.

**One direction only.** The header switch still does not write the profile. It is a per-device
control on every screen, and a student switching a borrowed phone to English must not silently
change the language Foxy answers their homework in. The asymmetry is deliberate and the hint
now describes what the button does rather than what the two settings are.

### D-382 · The browser suite needs fixtures the moment a screen stops having them

Re-recording the twelve stale baselines (item 46) could not start until `/student` rendered at
all. It reads three endpoints now, no backend runs behind the browser suite, and three failed
reads are an error state with no `h1` — Playwright's own assertion caught it, and a
screenshot of "your dashboard could not load" would have been a baseline saying the product
works.

**Decision:** `support/session.ts` owns `stubStudentData`, beside `signInAs`, and every student
route in every spec goes through it. **The fixtures are frozen in time.** `lastPractisedAt`
renders as a day and a month; a relative date would fail a screenshot next month with nothing
changed in the product, and a gate that cries wolf on a calendar teaches everyone to
re-record without looking.

`foundation.spec.ts` was asserting the heading "Good afternoon, Aarav" — a fixture name and a
time of day that no longer exist. That assertion had been stale since the dashboard went live
and passed anyway, because it was only ever run against the fixture screen.

### D-383 · Every "preview" claim is gone, and `--update-snapshots` cannot be trusted to rewrite

The sidebar card said "Sample information is shown while the product services are being
connected" on every authenticated screen. True when the shell was built; false from 12 August,
as the screens went live one after another. On a demo it was the first thing a viewer read, and
it contradicted the live data beside it (item 52).

Deleting it turned up three more of the same claim, all of them stale for the same reason:

- **`shell.studentRole` / `parentRole` were "Student preview" and "Parent preview"** — rendered
  under the name in the header and in every navigation's accessible label.
- **The parent layout passed that label as the USER NAME**, so the header read "Parent preview"
  where a person's name belongs. It is now `identityUnknown` ("Your account"), the same fallback
  the student header uses before its profile arrives. A parent has no learner profile to read a
  name from — there is no parent profile endpoint anywhere in the backend.
- **`ProgressSummary`** — the "Sample progress" card — had NO CALLER left once the dashboard
  went live. A dead component whose only remaining job was to carry the word "sample". Deleted
  with its test and its dictionary keys.

A shell test now asserts the words "preview" and "sample" appear nowhere in the shell, so this
cannot return quietly. The honest place for an unfinished-screen notice is that screen, not
every screen forever.

**THE TRAP WORTH RECORDING.** `playwright test --update-snapshots` reported "60 passed" and did
not rewrite a single baseline, twice, against a build that had genuinely changed — verified
afterwards by deleting one file and regenerating it, which produced a different hash. Do not
read a passing `--update-snapshots` run as "the baselines are current". **Delete the snapshot
directory and regenerate**, then run the suite again clean to prove the new files are what the
app renders. That is what was done here: 28 files, then 126 browser checks green against them.

### D-384 · A session serves one question at a time, chosen as it goes

Adaptive practice needs to know, before it draws the second question, whether the first was
answered well and quickly — which means the difficulty a session serves cannot be fixed at
`startSession`. The plan's original shape, and the one considered here, was a FROZEN SET: draw
all `questionCount` questions up front, at whatever difficulty the student's mastery implied
that day, and let the student work through them in order.

**Decision:** `startSession` serves exactly one question, and `submitAnswer` returns the next
one — chosen from the ladder replayed over every answer given in this session so far — or
`null` when the target length is reached or the chapter has nothing left to serve. The client
holds one question, not a list.

**The frozen set was rejected because it cannot adapt to what it exists to adapt to.** A
mastery snapshot taken at `startSession` describes the student BEFORE today's session, not
during it — a student who answers the first three questions right has told the ladder
something a set drawn a minute earlier cannot act on. Freezing the set would mean the
"adaptive" system only ever adapts across sessions, on yesterday's evidence, while today's six
questions run at one fixed difficulty regardless of how the student is actually doing — which
is the exact behaviour this work exists to replace.

`AnswerResult.questionCount` and `SubmissionResult.questionCount` carry different numbers on
purpose. The first is the session's TARGET, read once by a progress indicator; the second is
what was actually SERVED, read once the session is over. They differ only when a chapter runs
dry before the target is reached, and a comment sits at both call sites saying so — the two
fields looking identical is exactly how a future reader "fixes" one of them into a duplicate.

### D-385 · The ladder is derived from the session, not stored on it

Once a session serves one question at a time, something has to decide, after every answer,
which difficulty to draw next. The considered alternative was a `current_rung` column on
`practice_sessions`, updated in place as each answer lands — the obvious shape, and the one
that matches how `mastery_score` already works.

**Decision:** `classifyAnswer` and `rungAfter` (`domain/difficulty-ladder.ts`) are pure
functions with no I/O. `rungAfter` is called on every question served, REPLAYING the session's
answers-so-far into a rung: two qualifying answers in a row step it up, one wrong answer or two
slow-but-correct ones step it down, and nothing else moves it. `startingRung` reads the
student's evidence label from `chapter_mastery`, so a first session starts where nobody can
fail on arrival.

**A stored rung was rejected as a second source of truth for a number a twenty-item loop
computes for free.** A session holds at most twenty answers; replaying them is not the
expensive path a cache would be justified against. What a stored column buys instead is a
place for the rung and the answers to disagree — a retried write that updates the column but
not the response, or a migration that touches one and not the other, produces a session whose
rows say one thing and whose `current_rung` says another, and nothing would notice until a
teacher screen reads the wrong one. The replay cannot drift, because it has nothing to drift
from.

**The three-second floor is not a tuning knob.** `MIN_CREDIBLE_ANSWER_MS` (3,000ms) sits ahead
of the correctness check in `classifyAnswer`: an answer given faster tells the ladder nothing,
including when it is right, and is classified `discounted` rather than `qualifying` or `wrong`
— it is recorded and counted, and it moves nothing. Removing the floor, or letting a fast
correct answer step the rung up, would teach a student the fastest way to a harder question is
to stop reading it, which is the same failure `anti-cheat.ts` already zeroes a whole attempt
for at the same threshold. A ladder that rewarded exactly the behaviour the anti-cheat system
exists to catch would have been fighting itself.

### D-386 · `time_target_ms` is frozen onto the response, not read from the constant

`TIME_TARGET_MS` (`domain/time-targets.ts` — easy 30s, medium 45s, hard 60s) is what
`classifyAnswer` compares an answer's `timeSpentMs` against to decide `qualifying` versus
`slow`. The considered alternative was reading it live: store nothing, and have any later query
join `practice_responses.authored_difficulty` against the current constant.

**Decision:** `practice_responses.time_target_ms` records the target that was actually in
force for the difficulty a question was served at, at the moment it was served — the same
freeze `authored_difficulty` already applies to the difficulty itself, for the same reason.

**A live join was rejected because tuning the constants would rewrite history.** These targets
are a first guess, not a measured floor, and they will move once real timing data exists. A
live join means that the day `TIME_TARGET_MS.easy` changes from 30 seconds to 25, every
response ever recorded at `easy` is retroactively reclassified — an answer that qualified in
March starts reading as `slow` in a report run in April, with nothing about March having
changed. That is precisely the mistake `authored_difficulty`'s own comment already warns
against for the difficulty column, and a pace column that ignored the warning one field over
would have reintroduced it. The frozen value is what makes the pace query in `PROGRESS.md`
trustworthy at all: `avg(time_spent_ms) <= avg(time_target_ms)` means something stable only if
`time_target_ms` cannot move under an already-recorded row.

## Content provenance and its ceiling — recorded 20 August 2026

Not a decision; a set of facts a future session needs before it plans content work, and
which took an afternoon to establish by reading two repositories and the database.

**What the corpus is.** Mathematics and science, grades 6-10, and nothing else: 4,686 chunks
(4,666 embedded), 137 chapters, 639 concepts, 2,741 questions. Grades 11 and 12 hold nothing,
and no other subject exists — while the profile offers grades 6 to 12.

**Where it came from.** NCERT textbook PDFs → `scripts/ncert-ingestion/` in the OLD project at
`D:\personal\alfanumerik\Alfanumrik` (discover → extract with `pdf-parse` → chunk to 200-500
tokens → embed → load, tagged `source = 'ncert_2025'`) → Supabase → a one-time read-only export
into `.corpus-extract/` → `npm run db:import-corpus` into this Postgres.

**The PDFs are in neither repository.** They were a local folder passed as `--source`. Nothing
in this repository can re-derive a chunk from a book, which is also why 63 of 137 chapter
titles are placeholders like "Part 2 - Chapter 1": the extraction step failed to find a title
and there is no document left to recover it from.

**`voyage-3`, or a full re-embed.** Every stored vector is 1,024-dimensional and produced by
`voyage-3`. A chunk embedded by any other model lands in a different vector space, and the
symptom is not an error — it is retrieval quietly getting worse. Any future ingestion either
uses the same model or re-embeds all 4,666 existing chunks in the same pass.

**The abstention floor is calibrated against THIS corpus.** Foxy refuses to answer below a
measured fused-score threshold, and the retrieval service refuses to start if that threshold is
uncalibrated. A large import shifts the score distribution and the floor must be re-measured —
otherwise the product either answers from weak matches or abstains on good ones.

**What the product can honestly claim today:** it tutors mathematics and science for grades 6
to 10. Asked anything else, Foxy says it does not have the material rather than inventing an
answer. That is the safe failure and it is also the ceiling.

---

## New retrieval module (Track B) — 21 August 2026

Design decisions for a **separate** system, specified in
`docs/superpowers/specs/2026-08-20-ncert-rag-design.md`. **None of these change Foxxy.** Its
`retrieval` module is live and demoed and is explicitly out of scope. They are recorded here
because a future session reading this log must not confuse the two systems, and because three
of them are direct reactions to defects this log already records.

### D-387 · Track B is a new module in its own repository; Foxxy's `retrieval` is untouched
**Status:** Active (approved 21 August)
The client wants a production retrieval system at 90%+ measured accuracy. Foxxy's retrieval already works and is in the demo.
**Decision:** build new, separately. Foxxy's `retrieval` module is not modified, not refactored, and not migrated. The new module lives in its own repository; only its spec lives in `docs/superpowers/specs/`, because Foxxy is its expected first consumer.
**Consequence:** two retrieval systems coexist indefinitely. Track B replaces nothing until its gates are green, and the swap — if it ever happens — is a separate decision with its own entry.

### D-388 · The parent architecture is the client's AGTS dossier; our spec is its §5-6
**Status:** Active
The client supplied *Alfanumrik Grounded Teaching System* v1.0 (21 August), an architecture and research dossier with 47 references. Our independently-written design matched it at the retrieval layer and was a strict subset in scope.
**Decision:** adopt AGTS as parent. Our spec becomes the implementation spec for its §5 (content supply chain) and §6 (retrieval fabric). **AGTS wins on policy; our spec wins on implementation detail.**
**Consequence:** the pedagogy controller, learner model, assessment integrity, and policy gate are AGTS-owned and are consumed as QueryPlan inputs. Track B must never implement them — spec §0.2 lists them explicitly so the boundary survives into the plans.

### D-389 · `blocks` and `learning_objects` are separate tables
**Status:** Active
Parsing is expensive and irreversible — VLM calls, Mathpix credits. Chunking strategy will change many times before gates go green.
**Decision:** raw layout output persists in `blocks`; retrieval units are composed from blocks by a pure, versioned function. Re-chunking never re-parses.
**Consequence:** this is the direct answer to the provenance note above. Foxxy's chunks came from `scripts/ncert-ingestion/` in a repository that no longer exists, fed by PDFs held in neither repo — **it cannot be re-chunked at any price.** A permanent quality ceiling bought for no upfront saving. Track B pays that saving back as one extra table.

### D-390 · Gold labels anchor to `block_ids`, never object ids
**Status:** Active
An eval set anchored to chunk ids is invalidated by every chunking change.
**Decision:** an object counts as gold if it covers any gold block.
**Consequence:** chunking becomes a free variable. Without this, every chunking experiment costs a full re-label, so the experiments stop being run and the recall left in the parser is never recovered. This is the second reason D-389's table exists.

### D-391 · The eval harness is built before any ingestion code
**Status:** Active
Foxxy's `eval/retrieval/golden/types.ts` is `{ query, grade, subject, note }` — **no gold chunk id.** `harness.ts` measures separation between two score distributions, which calibrates an abstention threshold; it does not measure whether the right passage was retrieved. So retrieval correctness has never been computed in this project, and a number that is never computed cannot be improved, defended, or regressed against.
**Decision:** Phase 0 builds `eval_cases`, 50 block-anchored hand-labelled cases, and a per-slice gate runner. No ingestion code exists until a real recall number is reproducible from a git sha.
**Consequence:** the whole phase order follows from this. 3,892 lines of careful retrieval in Foxxy, and no way to score it — that outcome is the thing being designed against.

### D-392 · Every source is QUARANTINED by default, NCERT included
**Status:** Active (**corrects a claim made earlier the same day**)
An earlier draft treated NCERT as freely redistributable and gated only third-party books. AGTS [R45] records that NCERT explicitly asserts copyright over its textbooks. Public availability is not permission to embed, transform, or reproduce.
**Decision:** `sources.status` defaults to `QUARANTINED`. It becomes `APPROVED` only with a `rights_register` row carrying a recorded basis and a named approver. Enforced three times — quarantine blocks the parser, the embed stage refuses unapproved sources, the query path joins on approval and rights validity.
**Consequence:** **source rights are on the critical path for Phase 1**, and it is a business dependency, not an engineering one. If a documented basis cannot be secured for a source, that source does not ship and the coverage claim shrinks with it.
**AMENDED the same day by D-397** — the client holds the rights, so the schedule impact is withdrawn. The mechanism described above survives unchanged; only the blocking behaviour changes, to APPROVED-with-basis-recorded rather than blocked-until-approved. **Read D-397 before acting on this entry.**

### D-393 · Policy filters execute before scoring, never after
**Status:** Active
AGTS D8. Foxxy already filters grade and subject in the `WHERE` and was right to; Track B extends the same rule to tenant, role, entitlement, approval, active manifest, and disclosure class.
**Decision:** no candidate may be scored that the actor is not authorised to see.
**Consequence:** post-filtering a scored set is worse than wrong — it is *intermittently* wrong, returning two rows for a narrow filter and reading as a thin corpus. In graded mode it is a zero-tolerance failure: a solution object that was scored and then discarded still touched the ranking, and is one bug away from touching the renderer. Solutions and rubrics are therefore separate objects with their own ACL — structurally unaddressable, not filtered out afterwards.

### D-394 · A post-rerank pack-recall gate, kept against the dossier
**Status:** Active
AGTS G1 gates `Recall@20` over candidates. Nothing in the dossier measures what survives reranking into the pack the renderer receives.
**Decision:** keep our G2 — gold span present in the *delivered* EvidencePack, ≥90%, evaluated per teaching action.
**Consequence:** a reranker can hold 20 correct candidates and still order gold into slot 9 of a 5-slot pack. G1 passes at 0.95, the renderer gets nothing usable, and the failure surfaces three stages downstream as a correctness regression. G2 gives rerank quality its own number and its own blame.

### D-395 · Exactly one bounded corrective retrieval, then abstain
**Status:** Active
Agentic retrieval has the highest ceiling on hard questions and is non-deterministic, which makes gate numbers unstable and collapses the measurement discipline the design rests on. AGTS §6.5 is stricter still: *"Repeated free-form search loops are prohibited."*
**Decision:** on a sufficiency-gate failure the planner may run **one** bounded correction — rewrite, lexical variant, one reviewed graph edge, authoritative parent, or OCR→page-region. A second failure is terminal: CLARIFY, ABSTAIN, or ESCALATE.
**Consequence:** abstention stays a successful outcome decided before the renderer is called, which is the one thing Foxxy's `foxy` module already gets right and which is kept unchanged.

### D-396 · Per-slice gating; a single averaged 90% is not a pass
**Status:** Active
One number hides everything. "90% overall" with grade-11 physics at 60% is a product that fails its hardest users while passing its gate.
**Decision:** every gate is evaluated independently on grade × subject × teaching_action × question_type × language × modality × evidence condition. A gating slice (n ≥ 20) below its floor fails the whole run. Four named exceptions with lower floors exist, each with a written justification, and spec §2.2 closes with the rule that nothing may be added to that table without one.
**Consequence:** that table is the complete list of places where a number means something other than what the gate says.

### D-397 · Source rights are held; quarantine stays as mechanism, not as a blocker
**Status:** Active (client statement, 21 August 2026). **Amends D-392.**
D-392 made every source quarantine by default and put rights approval on Phase 1's critical path, because NCERT asserts copyright over its textbooks [R45].
**Client statement, 21 August:** rights to use NCERT and the other books are already held.
**Decision:** **rights are no longer a blocker.** Phase 1 is not gated on them. The `rights_register` table and the `QUARANTINED → APPROVED` transition **stay in the design** — one row per source is nearly free, and it is the only thing that lets the claim be *proved* later to a school, a board, or a counterparty. Sources now start APPROVED with the basis recorded, rather than blocking until someone approves them.
**Consequence:** D-392's *mechanism* survives; its *schedule impact* is withdrawn. Spec §13.7's "rights may shrink the corpus" ceiling no longer applies. **Named pilot scope is now the only non-engineering blocker on Phase 1.** If the rights position later proves narrower for one source — a specific edition, a territory, a third-party title — the mechanism is already there to quarantine that source alone without touching the rest.

### D-398 · Track B's build order is the client's AI-native guide; our plan and spec drop to authority 3
**Status:** Active (24 August 2026). **Supersedes `docs/superpowers/plans/2026-08-21-rag-build-guide.md`.**
The client supplied *Alfanumrik Grounded Teaching RAG — AI-Native Build Guide* (revised 22 August 2026): parallel LLM coding agents with blocking human approval gates, targeting a runnable prototype in 12-24 hours, an engineering release candidate at 72 hours, and a pilot-ready build within seven days. Our plan assumed human-paced work and estimated 17-19 weeks.
**Decision:** adopt it. Its §2 authority order governs — (1) the founder-approved AGTS architecture, (2) the client build guide, (3) versioned implementation specs, (4) decision logs and release evidence. `2026-08-21-rag-build-guide.md` is **superseded**; `2026-08-20-ncert-rag-design.md` v2 becomes **authority 3**, consulted where the client guide is silent and overridden where it is not.
**Consequence:** the quality bars did not move — the client's §14 carries the same numbers our spec §2.1 did, so nothing was weakened to buy the speed. What changed is the execution model and the clock. Most of our 17-19 weeks was code, and code is what compresses; the human assurance window (rights, curriculum sign-off, two-reviewer adjudication, privacy and security review) does not, and the client guide correctly schedules it at Days 4-7 rather than pretending otherwise. Our spec keeps four things worth preserving: the pgvector HNSW pre-filter recall trap, the `blocks`/`learning_objects` separation rationale, the composition rules, and the runnable Phase 0 code in `2026-08-21-phase-0-howto.md`.

### D-399 · Source rights are blocking again — the client's own guide re-imposes it
**Status:** Active (24 August 2026). **Amends D-397, which amended D-392.**
D-397 recorded the client's verbal statement that rights to NCERT and the other books were already held, and withdrew rights from the critical path. The client's AI-native guide §5 says the opposite in its own words: every source starts `QUARANTINED`, only an authorised human reviewer may move **a specific checksum and version** to `APPROVED`, and *"verbal assurance is not a rights record."*
**Decision:** §5 wins. It is authority 2 and D-397 recorded an authority-3 position. Production corpus transformation is blocked until each source carries a signed record — owner or licensor, legal or licence basis, permitted storage / transformation / display / model processing, attribution, term, approver, evidence link.
**Consequence:** D-392's original position is restored, by the client rather than by us. `SourceRecord` in the new repository will not construct in an `APPROVED` state without a `RightsRecord` and a completed pre-parse scan, so this cannot be forgotten rather than decided. **Rights and named pilot scope are now both blocking**, and they are the two things the build clock pauses on.

### D-400 · Track B code lives in `D:\personal\agts-retrieval`
**Status:** Active (24 August 2026). Implements D-387's "its own repository".
**Decision:** new git repository at `D:\personal\agts-retrieval`, Python 3.12 + pydantic 2. Phase 0 delivered there on 24 August: §6.2 typed learning objects, §6.3 runtime contracts (all eight), §6.4 evaluation case schema, a deterministic §8.1 plan-builder seed, an authorisation boundary as a corpus method, a per-slice scorer with five zero-tolerance counters, and the §6.5 detection suite. 34 tests passing against synthetic fixtures.
**Consequence:** Foxxy holds only the superseded planning documents and this log. **Foxxy's `retrieval` module remains untouched** (D-387) and is now explicitly a post-design comparator only, per the client guide §1. Two findings from the first Phase 0 run are recorded in the new repository's `DECISION_LOG.md` as R-005 and R-007: a hand-picked abstention threshold measured nothing until it was calibrated against the answerable/unanswerable score separation, and `recall@20` returned 100% for the baseline *and all four deliberately broken retrievers*, so the client's headline gate was the one measurement that discriminated nothing.

### D-401 · One id per open of the app, and one view to read the day through
**Status:** Active (25 August 2026).
Three tables in this schema are called a session and none of them knows the other two exist. `sessions` is one row per LOGIN, and a cookie lives for weeks, so a student who opens the app five times in a day still has one row there. `chat_sessions` is one row per start-panel submit, written before the first message and never ended — there is no `ended_at` and no status. `practice_sessions` is one row per chapter tap, written before the first answer, and abandoned rows keep `submitted_at IS NULL` for ever with no sweeper. So one day of one student is N chat rows plus M practice rows joined by nothing but `student_user_id` and a timestamp — and a timestamp cannot separate two visits in one afternoon. "What did this student do today, and how many sittings was it" had no answer, which is the shape the question arrived in: *the db seems very clumsy*.
**Decision:** two changes and deliberately only two. (1) `visit_id uuid NULL` on `chat_sessions` and `practice_sessions`, partial-indexed. The CLIENT mints one uuid per app launch into `sessionStorage` and sends it as `X-Visit-Id`; `shared/http/visit-id.ts` returns NULL for anything that is not a uuid. (2) `v_learner_activity`, a hand-written view unioning both tables, for operations and psql. The lifecycles are NOT flattened into a shared `completed` flag: `outcome` labels each in its own vocabulary — `empty`/`used` for chat, `open`/`submitted` for practice — because forcing one column would have made the view read cleanly and lie.
**Rejected — the auth session id, which the server already has.** It is constant across exactly the opens being separated. Only the tab knows when the app was opened, so only the client can say. **Rejected — the actor object.** `identity.plugin.ts` states the actor is `{ userId, role }` and nothing else; a visit id is precisely the convenient property that note is about, and worse than most, because the actor is the AUTHENTICATED caller and this value is not authenticated at all. **Rejected — sending the header on every request.** A custom header is not CORS-simple, so it would add a preflight OPTIONS to every bodyless GET; it rides only on requests that already carry a body, where `content-type` forces that preflight anyway.
**Consequence:** the column AUTHORISES NOTHING and must never start to. It is client-supplied, so no lookup is scoped by it and no access check consults it; a caller may send another student's visit id and it is harmless only because of that. It is nullable permanently — absent on every pre-existing row, on non-browser callers, and whenever a proxy strips the header — because a correlation label must never be the reason a student cannot practise. Two existing tests failed on the view and both were right to: `learner-content-migration` counted it as an undeclared table (`information_schema.tables` counts views), and `tenant-not-null-migration` could no longer drop `practice_sessions` under it. The second fix is the better one — that test peeled a single named migration and now discovers the set from `listMigrations()` and peels newest-first, which is what its own comment always claimed it did. Not done, and deliberately: no terminal state on `chat_sessions`, no abandon-sweeper for practice, and no `learner_daily_facts` projection — that last one needs `tenants.timezone` first.

### D-402 · The admin panel — a read-only operations surface, and the rule it amends
**Status:** Active (25 August 2026). **Amends D-401.** Spec: `docs/superpowers/specs/2026-08-25-admin-panel-design.md`.
The monitoring machinery — eleven alert rules, a `metrics_events` sink, worker heartbeats, the job queue, `/health/live|ready|deps`, pool saturation, a breaker bridge — had no HTTP surface and no UI. It ran as `npm run ops:alerts` and was otherwise reachable only through psql. A system whose health can be inspected only by its author is a system with one operator for ever, and none of the seven non-learner roles in `PLATFORM_ROLES` had ever been grantable.
**Decision:** a `super_admin` operations panel that is **read-only** — the repository contains no `insert`, `update` or `delete`, enforced by lint rather than intended. The account is created by `npm run ops:admin-create`, never by signup; `SIGNUP_ROLES` stays `student|parent`. The gate answers **404, not 403**, because a 403 confirms a route exists. PII is **masked server-side**: no `email` field and no message `content` field exists on any admin response shape, so a component cannot leak one and a network tab cannot contain one. Every read writes an `admin.read` audit row.
**The cost, stated rather than buried:** admin routes **deliberately bypass `assertCanAccess`**, the one authorisation primitive in this codebase that is airtight — an operations surface reads across every tenant by definition. Three things stand in for it and all three are load-bearing: the gate is the only door and `admin-routes-are-gated.test.ts` proves every route carries it *by function identity* rather than by observing a status code; every read is audited; nothing writes. Remove any one and this stops being defensible.
**What this amends in D-401:** `v_learner_activity`'s comment said it was "for operations and psql, not for a route". `GET /api/v1/admin/learners/:id/activity` is now a route that reads it. Migration `0010_admin_view_comment` changes the sentence in the database rather than leaving code that contradicts it. Most of the old rule survives: the view still carries no access check, is not tenant-scoped, and no ordinary product route may read it. **Exactly one caller is allowed**, and a second needs the same three properties — gate, audit, deliberate cross-tenant scope — or it is a leak.
**Two rules this work respected rather than bent.** `platform/alerts` moved out of `scripts/ops` so the API could run a dry evaluation, which brought its SQL inside the "database access lives in a `*.repository.ts`" rule; the one-line fix was to add a fourth entry to the D-181 exemption block, whose own closing sentence is *"adding a fourth is not"*. Instead the SQL moved into `alerts.repository.ts` and the sanctioned glob widened to `src/platform/**` — not a fourth exemption, since an exemption lets a file break the rule and this lets a file keep it. Separately, `admin` was assigned the `worker` pool on cost grounds and `module-pools.test.ts` refused it: `worker` is reached from the worker entry point, and a module on it is live traffic competing with background jobs. It is on `core`, knowingly; if an admin screen is ever measured starving learner traffic the answer is a real `ops` pool with its own budget, which is an ADR.
**Consequence:** a defect worth recording — `admin-routes-are-gated.test.ts` initially passed while proving nothing. The app harness built no admin module, so every `/admin` request hit Fastify's route-not-found and the "a student gets 404" assertion was observing the wrong 404 entirely. Fixed by building the module in the harness; the 401-with-no-cookie case now guards against recurrence, because route-not-found cannot return 401. The stronger fix is that the gate assertion no longer infers from a status code at all. **The dry run cannot page anybody, structurally**: no dispatcher is constructed in that path, and the test asserts notification and mail counts are unchanged across a cycle that really does fire `readiness_failing`.

### D-403 · The admin panel audit — indexes, session lifetime, and a throttle on disclosure
**Status:** Active (26 August 2026). **Amends D-402.** Migration `0011_admin_list_indexes`.
D-402 shipped nineteen endpoints and eleven screens with every gate green, and an audit of the finished work found eleven issues in it. Two made the panel unrunnable by anyone who had not watched it being built; four were performance defects measurable on the development database; three were security debt on a surface that reads children's records.
**Decided, in the order they bite:**
**It could not be started.** `.env.example` listed one CORS origin, `:3000`. The panel runs on `:3002`, so a browser blocked every request before it left — the API log showed nothing, because nothing arrived. The committed defaults now carry `:3001` and `:3002` with a note saying why the absence is invisible from the server. There was also no `admin/README.md`, so the port, the CORS requirement and the `ops:admin-create` step were undiscoverable. Both fixed.
**Every admin list was a sequential scan.** `EXPLAIN` returned `Seq Scan -> Sort (created_at DESC, id DESC)` on `users`, `audit_log` and `practice_sessions`. `audit_log` is the sharpest case: it is the fastest-growing table in the product *because of this feature* — every admin read appends a row — and the panel is its only reader, so the screen got slower in proportion to its own use. Its three existing indexes all lead with a column the admin list deliberately does not filter on, since it reads across tenants and actors by design, and an index is only usable from its leading column inwards. Five indexes added; `EXPLAIN` with `enable_seqscan=off` now returns `Index Only Scan` on all five with no `Sort` node.
**`practice_sessions` had an index it could not use.** The index is `(student_user_id, started_at DESC)`; the list ordered by `created_at DESC`. Two timestamps, one index, the wrong one named. The query moved to `started_at`, which is also the more honest column — written from the injected clock when the session begins, where `created_at` is a row-insert default — and the keyset cursor moved with it, since a cursor keyed on anything but the ORDER BY skips and repeats rows.
**Nine exact `count(*)` on the incident screen.** The counts must stay exact — `pg_stat_user_tables` was tried in this repository and reported 0 for tables holding thousands — so the fix is counting less often, not counting cheaper: a 30-second cache, sized against how the screen is *used* rather than against a freshness requirement. The alert signals and the job queue are deliberately not cached; those are the numbers that move on the timescale an incident does.
**An operator session lasted thirty days.** That was the learner policy applied to a credential nothing about the learner policy was reasoning about: a learner is meant to stay signed in, and a `super_admin` cookie reads every learner record across every tenant. Now twelve hours, applied at issue against the *current* role — so promoting an account shortens the session it is already holding, and shortening the policy cannot log every operator out mid-incident.
**Reveal was audited and unthrottled.** An audit trail records enumeration; it does not prevent it, and four hundred identical `support_request` reveals is evidence discovered afterwards. Thirty per hour per actor, checked *before* the row is read so a refusal is not a disclosure and does not appear in the trail looking like one. A cache failure **refuses** rather than opening the gate — losing a cache must not silently remove the only limit on bulk disclosure.
**`admin:create` had no opposite.** `ops:admin-revoke` demotes to `support_agent` and deletes every session in one transaction. It demotes rather than deletes because `audit_log.actor_user_id` is deliberately not a foreign key so a removed operator's trail survives them; it refuses any account that is not currently `super_admin`, because a script that could set any role to any other is a privilege-escalation tool with a friendly name.
**Consequence:** one finding in the audit was wrong and is recorded as such — `compose.yml` was faulted for having no admin service, but it has no application service at all, only postgres and valkey. Adding one would have broken the pattern rather than followed it. Two smaller items closed: the overview's chunk count is renamed `ragChunksActive` because it counted active chunks while the coverage screen counted all of them and neither said so, and `00-ARCHITECTURE.md`'s repo layout now names `admin/`. Suites after the work: 2,857 unit, 403 integration, admin app gates green, migration round-trip intact. **The panel has still never been opened in a browser** — every fix above was verified through `EXPLAIN`, tests and curl, which proves the API and not the screens.
