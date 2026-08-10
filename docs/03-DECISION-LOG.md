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

### D-080 · The rate limiter moves to `platform`, and the global limit hooks `onRoute`
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

### D-178 · `identity` gets the mutation test the other three modules already had
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

### D-179 · `content.authoriseRead` is asserted through the SERVICE, per use-case
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

### D-180 · The delivery plan's channel decision is enforced on the wire, and now observed
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

### D-181 · `notify` could not tell Hindi from English
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

### D-182 · The database half of digest idempotency is now observed
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

### D-183 · Two comments that asserted coverage which did not exist
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
