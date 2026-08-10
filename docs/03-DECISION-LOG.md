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

### D-078 · 2,564 chunks carry no embedding and must be re-embedded
**Status:** Active
9.2% of chunks are stamped `mistral-embed` with a **NULL vector**. They are invisible to vector retrieval. Re-embed with `voyage-3` at 1024 dimensions to match the rest. Cheap, one-time, and it must happen before threshold calibration — otherwise the calibration is measured against a corpus with a 9% hole in it.

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
