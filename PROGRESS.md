# Progress

**Read this first when resuming work.** It records what exists, what is next, and what must not be forgotten.

**Update rule:** this file is updated at the end of every working session, before stopping. If it disagrees with the code, the code wins and this file was not updated — fix it immediately. A stale progress file is worse than none, because it is trusted.

Last updated: **10 August 2026**

---

## 1. At a glance

| | |
|---|---|
| Project | Alfanumrik platform · Foxy AI tutor · Foxxy repository |
| Flows | Student · Parent |
| Core capability | Foxy — NCERT-grounded RAG tutor with citations |
| Retrieval | **CALIBRATED.** Sparse half rewritten to OR + `ts_rank_cd`: zero-candidate rate **44.4% to 0.0%**, mean candidates 3.87 to 49.19. Abstain threshold is now **MEASURED** (0.029877) against real voyage-3 distributions, on a 5% false-abstain budget rather than the midpoint, which would have wrongly refused 24% of answerable questions (D-216) |
| Dev database | **`foxxy_dev`, provisioned clean 11 August.** The previous one was a fossil of the superseded chain - it held the corpus but had none of the practice, parent, foxy, billing or notification-preference tables, and its ledger carried timestamps above the current baseline, so `db:migrate` would have skipped two migrations and reported success. New database, 7 migrations verified table by table, corpus re-imported from the local extract. **The armed migration hazard is gone** |
| Corpus | **IMPORTED.** 137 chapters · 4,686 chunks · 2,741 questions · 639 concepts · 176 edges · 57 misconception patterns |
| Architecture | Modular backend + isolated product frontend + marketing/CMS deployable |
| Team | 1 engineer |
| Pedagogy foundations | **3 of 9 delivered 10 August** — `platform/rules` (versioned deterministic evaluator), `modules/knowledge` (the 176 concept-graph edges finally have a reader), `modules/signals` (4 anomaly rules). **`knowledge` and `signals` are now WIRED** in `app/routes.ts`, both on the `core` pool, and **neither registers routes — by design** (D-175). `signals` receives `practice`'s anti-cheat floor and verdict through its no-default injected edge, which `practice/index.ts` now exports additively (D-177). See §6 |
| Backend modules | **11 of 11 built AND WIRED** (identity, learner, content, notify, practice, parent, retrieval, foxy, **billing**, **knowledge**, **signals**). Every one is constructed in `buildModules`, and `src/app/__tests__/routes.test.ts` asserts the list exhaustively and pins each module's pool. **Eight register routes; three deliberately do not** — `retrieval` (D-122), `knowledge` and `signals`, none of which has an HTTP surface, with a comment at the foot of `registerRoutes` saying so because "built but never registered" reads exactly like an oversight (D-175). `billing`'s registration is **AWAITED**, the only one besides identity's: its webhook needs an encapsulated Fastify scope for a raw-body parser, and a dropped `await` 404s every genuine delivery in production only. The `payments` port lives on the container, guarded, with a **production boot refusal** (D-176) |
| Mail | **SMTP adapter BUILT, 11 August.** There was previously no real adapter at all - production defaulted to a console stub with no environment gate, printing verification and password-reset links to stdout and delivering nothing. `createContainer` now refuses to boot in production without SMTP settings (D-226) |
| Backend processes | **2** — `api` and `worker`. The worker exists and runs one real job |
| Frontend | **WIRED AND GATED, 12 August.** It makes real network calls for the first time. All five of step 0's foundation gaps are closed — session strategy, the error-code table, the Foxy streaming client (all 7 cases in plan §7 are tests) and the token scales — plus build-order step 6, the typed client and providers. Backend contracts are GENERATED into `src/lib/api/generated/` with a drift test, because `frontend/Dockerfile` copies `frontend/` alone and a direct cross-package import cannot exist in the image. **Tests 10 → 236 unit and 28 end-to-end.** Eleven CI gates exist and six have been deliberately broken and observed to fail; the two that cannot be (bundle budgets against a real build, Lighthouse) are blocked on item 33 and on CI ever running |
| Marketing site | **scaffolded** - 32 files under `website/`, committed. Per `06-FRONTEND-SEPARATION-PLAN.md` |
| Tests | **3,173 backend passing**, 185 files, plus **236 frontend unit and 28 end-to-end** (was 10 — see §5). Three audit waves have added 656 between them. **Every guard, threshold and validation in the codebase has been broken deliberately and confirmed to turn a named test red** - see D-214 |
| Migrations | `0000_baseline` + `0001_pedagogy` + `0002_practice` + `0003_parent` + **`0004_billing`** + **`0005_foxy`**. Every one has a rollback test, because the round-trip is asserted over the DISCOVERED set rather than per file (D-126) — neither `0004` nor `0005` needed an edit to that test. **Neither has been applied to the development database**, deliberately, for the same reason `0002` has not: see open item 16. ✅ **`0004_billing`'s journal `when` is FIXED** — it was 1786374108357, below `0003_parent`'s 1786700000000, which is the exact D-109 hazard: drizzle selects by `when` and not by `idx`, so on any database already past `0003` it printed "Migrations applied." and applied nothing. **Reproduced on a scratch database before the fix** (`subscriptions` and `payment_events` absent, `0005` applied over the hole, exit code zero), corrected to **1786750000000**, and re-verified both from empty and from a ledger primed to `0003`. The rule is now enforced by `tests/integration/migration-journal-order.test.ts`, which was itself proved to fire by reverting the value. The round-trip test could not have caught this and never could: it applies by `idx` and never reads `when` (D-173, D-174) |
| Gates | type-check · lint · build · test — all green. `platform/authz` stays **100%**; `billing/domain` 98.5% statements / 96.2% branches / 100% functions, `billing.service` 99.2% / 95.1% / 90%, `platform/payments` 100% statements. `parent/domain` 100%, `parent.service` 94.0%, `retrieval` 99.1%, `practice/domain` 100%. **`modules/foxy` 96.3% statements / 90.4% branches / 94.6% functions**, with `foxy/domain` at 100%/99.0%/100% and `platform/llm` at 98.5% — the real LLM adapter is fully covered and never called |
| Deployment | **BUILT, 10 August.** `docker/compose.prod.yml` — postgres+pgvector · valkey · api · worker · alert evaluator · frontend · website · Caddy · backup. Three multi-stage non-root Dockerfiles, resource limits on EVERY service, an `internal: true` data network with no published ports, and volume names (`foxxy_prod_*`) that cannot collide with the development ones holding the corpus (D-140). Validated with `docker compose config` |
| CI/CD | **BUILT, 10 August.** `.github/workflows/` — `ci.yml` (change detection · secret scan · infrastructure checks · `ci-gate` fan-in) calling per-app `backend-ci.yml` / `frontend-ci.yml` / `website-ci.yml`. A documentation-only change runs the secret scan and nothing else. Migrations are an EXPLICIT step, never on boot (D-145). **Eight gates, each proven to FAIL on a deliberate violation** — see §3 |
| Backups | **BUILT AND DRILLED, 10 August.** Continuous WAL archiving plus a nightly base backup to a SECOND volume; `restore.sh`, `restore-drill.sh` and `drill-selftest.sh`. The drill was EXECUTED against a scratch database: PASS on a good backup, FAIL on a tampered one. Two real defects were found by running it (D-149) |
| Alerting | **BUILT, 10 August.** `backend/scripts/ops/` — 11 rules over 9 signals read from `metrics_events`, split explicitly into what PAGES a human and what files a TICKET, delivered through the existing `notify-channel` port rather than a second notification path (D-147) |
| Estimated remaining | **~80 days ≈ 16 weeks solo.** Backend is feature-complete and audited three times |
| Git | **9 commits**, latest `b6225f2`. Working tree clean. No remote configured - **CI has never executed a single job** across 184 test files |

---

## 2. THE NEXT ACTION

> **Three things only the owner can supply. Everything else is unblocked, and the database hazard is now cleared.**

1. **`LLM_API_KEY` in `backend/.env`.** Foxy runs on a scripted fake that does not read the prompt, so **answer quality is entirely unmeasured**. This also gates all content generation - hint ladders, misconception tags and Hindi questions are still at zero.
2. **A git remote.** Four workflows exist and every gate was proven to fail locally, but **GitHub Actions has never executed a single job** across 184 test files.
3. **Confirm the Foxy caps.** Set to `free: 20 / plus: 200` by default and now pinned to literals. They had drifted to 5000/9000, which is a 1.8x differentiator on a cap no student reaches - structurally a paid tier, commercially nothing.

### How to clear the three — exact commands

Run from `D:/personal/foxxy`. Nothing here touches the database.

**1. LLM key.** `backend/.env` is git-ignored; `backend/.env.example` is tracked, so never put the real value there (that mistake is D-096).

```bash
# append to backend/.env  - do NOT edit .env.example
echo 'LLM_API_KEY=sk-ant-...' >> backend/.env

# prove the fake is gone: a real key makes this answer from the corpus
cd backend && npm run dev
# then, in a second shell:
curl -s -X POST localhost:3000/foxy/ask   -H 'content-type: application/json' -H 'cookie: sid=<a real session>'   -d '{"question":"What is photosynthesis?","subject":"science","grade":"8"}' | head -40
```
The scripted fake ignores the prompt and returns a fixed string; a real key returns corpus citations. If the reply is identical for two different questions, the key did not load.

**2. Git remote.** 184 test files, four workflows, zero CI runs ever.

```bash
gh repo create foxxy --private --source=. --remote=origin   # or: git remote add origin <url>
git push -u origin main
gh run list --limit 5     # first evidence CI can execute at all
```
Expect the first run to fail on something environmental (secrets, Node version, service containers). That failure is the point — it is unknown today.

**3. Foxy caps.** One file, two literals.

```bash
grep -rn "FOXY_DAILY_CAP\|free: 20\|plus: 200" backend/src/shared/constants/
```
Confirm `free: 20 / plus: 200` or change both. They had drifted to 5000/9000 — a 1.8x gap on a ceiling no student reaches, which is a paid tier in name only. A test pins the literals, so changing them turns that test red **by design**: update the test in the same commit, never the constant alone.

### After those, the three worth doing first

Ordered by what breaks if ignored, not by size.

1. **Item 25 — the false degradation row.** `docs/04-RESILIENCE-PLAN.md` §6 promises keyword-only fallback; `backend/src/modules/retrieval/retrieval.service.ts:52-70` throws instead. §11 calls every row a testable requirement, so this is a stated guarantee with no test and contradicting code. **Decide which is true, then make the other match** — do not write a test against the doc without reading the service first.
2. **Item 33 — `next build` fails on this machine. The bundler is NOT the cause — tested 12 August.** `kill EPERM` at worker teardown, Next 16.3 + Windows. `next build --webpack` (the 16.x spelling of `--no-turbopack`) fails **identically**, so the flag theory is dead. What the webpack run adds is a narrower window: it reaches "Collecting build traces" and completes it, then dies — later than the Turbopack run, which never gets that far. So compile, TypeScript, static generation and tracing ALL succeed, and the crash is in worker teardown after every artifact-producing phase. `.next/` is populated; `.next/standalone/` is never written, which is what the Dockerfile consumes. **Next avenue: the build-worker pool, not the bundler** — `experimental.webpackBuildWorker`/worker count, or run the build inside the Linux container the image uses anyway and stop treating a Windows-host build as the target.
3. **Item 26 — read before touching the parent digest.** `recoveries` counts `answer_changed = true AND is_correct = true`, which immutable answers (D-281) made unsatisfiable. The metric will read zero. **That is the fix landing, not a regression** — the old numbers came from client testimony nothing verified.

### Unblocked and ready

| | Days |
|---|---|
| **A socket-level smoke test** - the only untested boundary in the backend | 1 |
| A Postman collection generated from the route definitions | 0.5 |
| `components/ui` primitives and `patterns`, then the auth screens onto the live client | 6 |
| Remaining open items in section 7 | 3 |

### The wire boundary is the one thing three audits could not reach

Every HTTP test runs through Fastify's `app.inject`, which calls the handler stack directly. Real routing, real plugins, real Postgres - **no socket**. So none of this has ever been exercised: CORS preflight from a browser origin, cookies as a client actually handles them, chunked transfer encoding, keep-alive, compression, TLS.

**The one that matters is SSE.** `app.inject` collects the whole response and hands it back as a single payload, so every Foxy streaming test - including the incremental citation-stripping fix, whose entire point is that a fabricated marker must never reach the student *mid-stream* - has only ever observed frames **after the response completed**. The property under test is "arrives incrementally"; the harness cannot distinguish incremental from buffered.

A scripted smoke test over a real socket, asserting measurable time between frames, is the only thing that closes it.

---

## 3. Done

### Foundation — 7 August 2026
- Repo, TypeScript strict, ESLint with boundary rules, Prettier, Vitest, Docker Compose (Postgres 16 + pgvector, Valkey)
- **Every ESLint boundary rule verified to fail on a deliberate violation.** Two were found enforcing nothing — see D-005
- Coverage gates proven to fail before being trusted — see D-006
- `platform/`: config, errors, logger, db, clock, id-gen, cache, http, events; interfaces for llm, embed, mail, payments
- Identity schema and migration `0000`; applies, rolls back, re-applies against real Postgres
- `platform/authz` — one boundary, deny by default, **100% coverage as a gate**

### Identity module — 7 August 2026
- Signup with enumeration defence · email verification · login with timing-attack defence · session validation with sliding renewal · logout and logout-all · password reset that deletes every session · parent-child linking with mandatory student approval and immediate revocation
- Rate limits per the specification, counters in the cache
- Argon2id, memory 19 MiB, iterations 2, parallelism 1
- Shared Zod contracts in `src/shared/contracts/` — the frontend imports the inferred types
- End-to-end HTTP flow passes: signup → verify → login → issue code → submit → approve → list children → revoke

### Resilience hardening — 8 August 2026
- Four separate connection pools (auth 10 · core 20 · ai 8 · worker 6), with a test proving a saturated `ai` pool cannot break login
- Circuit breakers on every port, all tests on the injected clock
- Timeout policy in config; retry with equal jitter that refuses non-idempotent calls
- Concurrency limits per port, reject-never-queue
- `/health/live`, `/health/ready`, `/health/deps` — liveness touches nothing external
- Graceful shutdown on SIGTERM
- `link_codes` table; "one active code per student" is now a partial unique index, not check-then-write
- Full 10,000-entry common-password corpus, O(1) lookup
- Rate-limit in-process fallback — **a cache outage no longer disables authentication**
- Origin check on state-changing requests, at `onRequest`
- `APP_URL` / `API_URL` config; redirects survive a reverse proxy

### learner + content schema — 9 August 2026

Schema and migration only. No module code — `learner` and `content` services are still to build.

- `learner`: `students` · `student_subjects` · `chapter_mastery`. Grade is **text** with a CHECK on `'6'..'12'` in all three places it appears
- `content`: `chapters` · `questions` · `rag_chunks`. **The four-option rule is a CHECK constraint**, not a validation — `correct_index` 0..3 alongside it means the index can never point past the array
- `rag_chunks` is shaped for a **straight column mapping** from the existing `rag_content_chunks` (~16,000 rows): same names, same types, same defaults, `vector(1024)` unchanged so no re-embedding. Indexes: HNSW (m=16, ef_construction=128), GIN on a generated `search_vector`, partial btree on (grade, subject) where active
- **All three one-way doors from section 8 are closed** — `distractor_misconceptions`, `is_held_out`, and the `question_responses` log, which lands three build steps ahead of the module that owns it
- Migration `0002_learner_content` applies, rolls back and re-applies against real Postgres, verified both in CI and by hand against a live container
- Per-module connection pools: `container.db` is **gone**, replaced by `poolFor(module)` over §3.1's table as code — **resolves D-030**
- Test harnesses now **discover** migrations from the directory and cross-check the drizzle journal, so the "harness applied only 0000" defect cannot recur
- Fixtures (`tests/fixtures/`) with deterministic synthetic 1024-dim embeddings, plus `npm run db:seed` — 6 chapters, 120 questions (36 held out, 30%), 180 chunks

### learner + content modules — 9 August 2026

Plan §8.2 and §8.3, in full: services, repositories, routes, shared contracts and tests.

- `learner`: `createProfile` · `getProfile` · `updateProfile` · `getSubjects` · `getMastery` · `updateMastery`, behind `GET`/`PATCH /me/profile`, `POST /me/onboarding`, `GET /me/mastery`
- **Onboarding is idempotent** — one transaction, `ON CONFLICT DO NOTHING` on both the profile and its subjects. A retry changes nothing, resets no grade and no mastery, and reports `created: false` (D-053)
- **`gradeSchema` is the only enforcement of "grade 6 as a NUMBER is rejected"** and now says so in four places, because D-038 proved the CHECK cannot do it
- `content`: `getChapter` · `listChapters` · `getQuestionsForChapter` · `getChunksByIds` (+ `getHeldOutQuestionsForChapter`), behind `GET /content/chapters` and `/content/chapters/:id`
- **The held-out reserve is protected by a function NAME, not a flag** — `getQuestionsForChapter` has no argument that could include it (D-052)
- Questions are hard-filtered by grade and subject through a JOIN on `chapters`, so a chapter id from the wrong grade returns nothing rather than the wrong grade's questions
- **`questions.distractor_misconceptions` is now a jsonb OBJECT keyed by option index** (migration `0003`), with a CHECK requiring exactly 3 entries, keys in "0".."3", and the correct option's key ABSENT — closes the last open one-way door (D-048, resolving D-044)
- **`hnsw.ef_search = 100` on the `ai` pool**, from config, as a connection parameter. A top-50 query now returns 50; the test has a control at 40 that proves it is still measuring something (D-049, implementing D-041)
- Cross-module edges are INJECTED, not imported: `app/routes.ts` is the complete dependency graph, and a new test pins which pool each module receives (D-051)
- `parseInput` moved to `platform/validation` — one place decides what a client is told about a malformed request (D-050)

### Foundation hooks — 9 August 2026

All six items in `docs/05-ROADMAP.md` section 8, in one pass. **None of the
features they support was built** — only the ground each stands on. Migrations
`0004`-`0007`. Decisions D-061..D-072.

- **`tenant_id`** on the six tables carrying student data, nullable with a
  default, indexed, `ON DELETE RESTRICT`. **The enforcement is not the column —
  it is `assertCanAccess`**, which denies a tenant mismatch BEFORE any allow rule
  is considered, so a parent reading a child they hold an approved,
  student-consented link to, in another tenant, is refused (D-061)
- **Role enum widened** from 2 values to 10 on `users.role`, so Phase 1 needs no
  locking DDL on a live table. **Signup still accepts exactly `student` and
  `parent`** — separate constants, pinned by a test that drives all eight
  widened roles at `POST /auth/signup` (D-062)
- **`schools` · `classes` · `class_enrolments`** — schema-only stubs. No module,
  no service, no routes, nothing reads them
- **`audit_log`**, append-only **by trigger**, not by convention. `actor_user_id`
  has no FK on purpose: any referential action collides with the trigger and
  makes account deletion fail (D-063). Wired into the four privileged actions
  that exist — password reset, logout-all, link approve, link revoke
- **`platform/pii`** — one scrubber for the two places caller-supplied data
  becomes permanent. PII-shaped keys dropped, PII-shaped values redacted, every
  scrub logged at `warn` and counted (D-064)
- **Five evidence columns** on `question_responses`, each with a
  `COMMENT ON COLUMN`. Nothing writes them yet; `practice` is step 11 (D-065)
- **`platform/notify-channel`** — `Channel` port, email + in-app adapters,
  `whatsapp` and `push` **declared and throwing** so enabling one before it
  exists is loud rather than silent (D-066, D-067). **Both languages are
  required at the type level AND by four `NOT NULL` non-empty columns**
- **`platform/metrics`** — closes the gap resilience plan §5 left open. Wired
  into breaker transitions, breaker rejections, concurrency rejections and port
  timeouts, plus D-034's rate-limit fallback. Exposed on `/health/deps` from
  memory, so it answers when the database does not (D-068)
- **The `worker` process** — separate entry point, `worker` pool, Postgres queue
  with `FOR UPDATE SKIP LOCKED`, idempotent keyed jobs, jittered backoff,
  stuck-job reaper, heartbeat row. One real job: the **expired-session sweeper**,
  which had been deferred on "the worker process" since 8 August (D-069..D-071)

### Wave 1 — half-done foundations closed — 10 August 2026

Five items, all of which were "declared but not enforced" rather than "not yet
built". Decisions D-073 (resolved), D-075 (resolved), D-080..D-086.

- **`tenant_id` is NOT NULL** on all six student-owned tables (migration `0008`),
  and **`assertCanAccess` now DENIES a missing tenant on either side**, not only
  a mismatch. The lenient rule did not avoid the retrofit migration `tenant_id`
  was added early to avoid — **it deferred it, while reading as complete**
  (D-073)
- **Every insert path supplies the tenant explicitly.** Signup takes it from
  configuration and never from the body — there is a test that posts a
  `tenantId` and asserts it is ignored. `learner` stamps rows with **the tenant
  the access check just passed on**, so "filed under the tenant that was checked"
  is true by construction. `submitLinkCode` refuses a cross-tenant pair with the
  same error as an unknown code
- **The resource tenant is read from the DATA, never copied off the actor.**
  Passing `actor.tenantId` would satisfy the type and compare a value with
  itself — a check that can never fail, in the shape of one that sometimes does
- **The drizzle snapshot chain is rebuilt** and `npm run db:generate` on a clean
  tree emits nothing — verified, not assumed. Per-migration snapshots for
  `0004`-`0007` could NOT be reconstructed (those schema states were never
  committed); the chain is linked rather than gapless, and the alternative — a
  collapsed baseline — is offered for the user to decide (D-081)
- **The global 100/min authenticated rate limit is applied**, as a shared plugin
  every future module inherits without opting in. It hooks `onRoute` because
  every app-level Fastify hook runs BEFORE route `preHandler`s, where the session
  is validated — an app-level hook would have seen no actor and throttled nothing
  (D-080)
- **`POST /links/code` is bounded at 5/hour per student** (D-085), and
  **`CORS_ORIGINS` is split** so a read-only partner origin can no longer POST
  (D-082)
- **The hardcoded-migration-list defect is now a lint error** (D-075). A THIRD
  instance was found; so was a fourth, inside the test written to prevent it

### Corpus import — 10 August 2026

Build step 6 CLOSED. Migration `0001_pedagogy`, `scripts/import-corpus.ts`,
`scripts/clear-content.ts`. Decisions D-098..D-109.

- **The whole extract is in local Postgres** — 137 chapters, 4,686 chunks, 2,741
  questions, 639 concepts, 176 edges, 57 misconception patterns, 773 held out.
  Counts and quality bars in section 2
- **Migration `0001_pedagogy`** — `chapter_concepts` · `concept_graph` ·
  `misconception_patterns`. Applies, rolls back and re-applies against real
  Postgres. **No `tenant_id` on any of the three** and a test asserting the
  absence with `students` as its control: they are curriculum, not student-owned
  data (D-105)
- **`concept_graph.concept_code` does not join to `chapter_concepts`, and no key
  was invented.** There is a test asserting that NO foreign key on any
  `concept_code` column exists, so the plausible-looking "improvement" fails
  loudly instead of deleting 37 of the 57 misconception patterns (D-105)
- **The import is idempotent, and that was PROVEN rather than asserted** — six
  content digests taken before and after a second run, identical, row counts
  unchanged. Every primary key is a deterministic UUIDv5 of the source id, and
  the namespace is pinned by a test because changing it inserts a second copy
  of the corpus rather than renumbering the first (D-102)
- **The import RECONCILES**, so "clear the dev seed first" is not a step anybody
  has to remember: rows not in the extract are deleted inside the import's own
  transaction. `npm run db:clear-content` exists for the other case, and is what
  removed the stray `chk_probe` table (D-103)
- **The reserve cannot shrink**, guarded twice — the current reserve is read out
  of the database before the transaction and passed into the plan, AND the
  upsert says `is_held_out = questions.is_held_out or excluded.is_held_out`
  (D-104)
- **`chunks.ndjson` is streamed**, twice, a line at a time. No embedding outlives
  the row it belongs to; 66 MB never becomes 300 MB of JavaScript numbers
- **Both retrieval paths were run by hand** against a real Grade 10 Science
  question and returned topically correct rows, not merely rows
- **The 1,045 excluded questions are a FILE**, not a log line —
  `.corpus-extract/reports/excluded-questions.ndjson`, every id with its reason,
  because a number cannot be fed back into the regeneration job that has to
  target exactly those ids

### practice module — 10 August 2026

Build step 11 CLOSED. Migration `0002_practice`, `src/modules/practice/` (28
files), `platform/tx`. Decisions D-110..D-121. **231 new tests; 1,684 passing.**

Six of the client's nine session steps: Today's Mission -> Concept Explanation
-> Guided Practice (hint ladder) -> Independent Mastery Check -> Evidence-Based
Decision -> Retention Scheduling. Prerequisite recall, prerequisite recovery and
teacher alerts are OUT OF SCOPE and were not stubbed — the first two need a
concept graph whose codes join to nothing (D-105) and the third needs a teacher
who does not exist.

- **`startSession` · `getSession` · `submitAnswer` · `submitSession` ·
  `getHistory` · `getProgress` · `getTodaysMission`**, behind seven
  `/api/v1/practice/…` endpoints. Route handlers are 5-8 lines each: validate,
  call one service method, format
- **Ten pure domain modules at 100% statement coverage** (99.1% branch):
  scoring, xp-rules, anti-cheat, option-shuffle, hint-ladder, evidence,
  spaced-retention, decide-next, mission, mastery-update. Service 93.9%.
  `platform/authz` still 100%
- **Migration `0002_practice`** — `practice_sessions`, `xp_ledger`,
  `practice_retention`, plus D-057's merge: `question_responses` **RENAMED** to
  `practice_responses` with the `session_id` the merge exists for. Forward,
  backward and forward again, verified against real Postgres. **A rename, not a
  drop-and-recreate** — a recreate would have silently discarded every
  `COMMENT ON COLUMN` the evidence columns carry, and a migration whose safety
  depends on a table still being empty is one nobody can trust (D-110)
- **Submission is ONE transaction and it spans two modules' tables** (D-056,
  D-112). `platform/tx` exports an opaque `TransactionToken` — brandable only
  inside `platform/db`, unwrappable only from a `*.repository.ts` — so
  `practice.service` can HOLD a transaction, hand it to `learner.updateMastery`,
  and still be unable to run a statement with it. **There is a test that injects
  a failure at exactly that cross-module seam and asserts that NOTHING lands:
  no responses, no score, no XP row, no schedule, and the session still
  submittable**
- **Every persisted index is the ORIGINAL one** (D-058). The per-session shuffle
  map lives on `practice_sessions.option_order`; every selection is translated
  back before anything is written. **Proved with a shuffle that actually
  reorders AND at a position the map actually moved** — see D-121, because
  neither precondition is automatic
- **Held-out questions cannot be served, structurally.** The module is given
  `content.getQuestionsForChapter`, which has no argument that could return the
  reserve, and is NOT given `getHeldOutQuestionsForChapter`. It has no way to
  ask. Two tests: none of the reserve is drawn even when it would fill the
  requested count, and no response row ever joins to a held-out question
- **Every evidence column is written on every response** — `first_selected_index`,
  `answer_changed`, `hint_level_used`, `confidence`, `time_spent_ms`,
  `authored_difficulty` (D-065). Asserted column by column out of the database,
  because none of it can be backfilled
- **An invalid attempt scores zero, records WHICH rule failed, keeps its
  responses, and still writes a ZERO XP ledger row** — so "awarded nothing" and
  "never submitted" cannot look the same
- **Today's Mission states WHY, from real rows** — days overdue from
  `practice_retention`, the attempt count and evidence LABEL from
  `chapter_mastery`, the chapter number from `chapters` — in both languages,
  built together at the point of construction. The only fixed string in the file
  is "nothing is due and nothing is weak", which is honest (D-119)
- **The hint ladder degrades rather than pretends** (D-115). With
  `hint_level_1..3` and `solution_steps` NULL across the corpus, every rung
  reports `available: false` with a reason that distinguishes "nobody has
  written this" from "serving it would BE the answer". It never invents a hint,
  and `QuestionHints` has no field for `correct_index`, `explanation` or
  `options`, so no rung can reveal the answer even by mistake
- **`remediate_general` is a separate decision from `remediate_misconception`**
  (D-114). Collapsing them would make the D-077 content gap read as a healthy
  metric

**The dev database has NOT had `0002` applied** — see section 7, item 16. The
corpus was re-counted after all of this and is byte-identical: 137 chapters,
4,686 chunks, 2,741 questions, 639 concepts, 176 edges, 57 patterns, 773 held
out.

### Deployment, CI/CD, backups and alerting — 10 August 2026

Resilience plan §5, §7, §8, §11, §12 and §13, and the CI/CD and pipeline
isolation requirements of `06-FRONTEND-SEPARATION-PLAN.md`. Decisions
D-140..D-149 and D-160..D-162. Nothing under `backend/src/` was touched.

- **`docker/compose.prod.yml`** — nine services: postgres+pgvector, valkey, the
  api, the worker, the alert evaluator, the frontend, the marketing website,
  Caddy, and a backup container (plus a one-shot volume-permission init and a
  `profiles: [migrate]` migration runner). Named volumes, healthchecks, restart
  policies, and **CPU and memory limits on every service** — marketing gets the
  smallest budget in the stack, because it is the surface with the most frequent
  and least reviewed deployments.
- **Two networks.** `edge` carries Caddy and the three application containers;
  `internal: true` carries postgres, valkey and backup and has **no route to the
  internet and no published ports**. The database is reachable only by container
  name from a container on that network (D-141).
- **Nothing can touch the development stack.** Project name `foxxy-prod`, every
  volume `foxxy_prod_*`. The isolation is not a convention — the names do not
  collide (D-140). `backend/docker/compose.yml` was not edited.
- **Three multi-stage Dockerfiles**, non-root, minimal. The backend image builds
  `dist/` (api + worker) AND `dist-ops/` (migrations + alert evaluator),
  because the runtime installs `--omit=dev` and an ops tool that needs `tsx` is
  an ops tool you cannot run on the box that is on fire. The Next apps use
  `output: 'standalone'` and install no node_modules at runtime.
- **Caddy, automatic TLS, three hostnames** derived from ONE placeholder:
  `{$BASE_DOMAIN}` in `docker/.env.prod`. `compose.prod.yml` builds `APP_URL`,
  `API_URL` and both CORS lists from the same variable, so the proxy's routing
  and the backend's origin allow-lists cannot disagree.
- **The SSE route has its own proxy policy** (D-142) — `flush_interval -1`, a
  300s upstream read timeout, a 30s header timeout, and no compression, scoped to
  `/api/v1/foxy/*`. Ordinary routes keep 30s and keep compression. Getting this
  wrong breaks Foxy in production **while looking exactly like a model problem**,
  which is why CI asserts both settings by name: `caddy validate` is perfectly
  happy with a config that buffers.
- **Proxy ownership is enforced in three layers** (D-143): a read-only mount, an
  allow-list deploy script (`docker/deploy-app.sh`, which refuses `caddy`,
  `postgres`, `valkey`, `backup` and uses `--no-deps`), and CODEOWNERS.
- **Path-scoped workflows AND a real fan-in gate** (D-144). A documentation-only
  change runs the secret scan and nothing else. `ci-gate` is `if: always()` and
  inspects `needs.*.result` explicitly, because a skipped required check reports
  as neutral, which reads as green.
- **Migrations are a discrete step and the step CHECKS THE CATALOGUE** (D-145),
  because D-109 proved that a zero exit code from `db:migrate` means nothing. The
  round-trip — forward, rollback to a provably empty schema, forward again,
  catalogues diffed — runs against the CI Postgres SERVICE, where a real ledger
  history exists and testcontainers cannot help.
- **A secret scanner that fails the build** (D-161), closing D-096's open action.
  Self-testing, so that a scanner whose patterns have rotted cannot report
  "clean" and be believed.
- **Backups: continuous WAL archiving plus a nightly base backup, to a SECOND
  volume.** Restore, drill and drill-self-test scripts. **The drill was run.**
- **Alerting: `metrics_events` is finally READ.** 11 rules over 9 signals, an
  explicit page/ticket split, delivery through the existing `notify-channel`
  port. The evaluator refuses to start without a recipient (D-147), and an
  absent signal never fires a rule and is never read as zero (D-148).

**Every gate was proven to FAIL on a deliberate violation before being trusted**
(the D-005 rule, applied to infrastructure):

| Gate | Violation injected | Result |
|---|---|---|
| secret scan | the exact D-096 string, in the exact file D-096 happened in | exit 1, host named; file restored byte-for-byte |
| secret scan self-test | — | 11 fixtures, 8 must-flag / must-not-flag pairs plus 3 token shapes, all as required |
| `compose config` | an invalid resource limit | exit 15 |
| shell parse (`bash -n`) | an unterminated `for` | exit 1 |
| SSE buffering assertion | `flush_interval -1` deleted | exit 1 |
| SSE timeout assertion | SSE `read_timeout` lowered to 30s | exit 1 |
| `caddy validate` | a malformed include | exit 1 |
| `ci-gate` logic | an app pipeline failing; the secret scan SKIPPED | exit 1 in both |
| migration round-trip | a table the down migrations do not drop | exit 1 |
| migration round-trip safety | a database holding rows | refused; rows untouched |
| restore drill | a tampered row-count expectation | FAIL, as required |

**Two defects the proofs found, which reading would not have** (D-162, D-149):

- The shell-parse gate reported a PASS on a file with a deliberate syntax error,
  because `git ls-files '*.sh'` matched nothing before the scripts were staged
  and the loop body never ran. That is D-005's "rule matching zero files" wearing
  a shell loop; the step now fails on zero matches. Separately, the first
  violation used to test it — `if [ "$x" = 1 ; then … fi` — is ACCEPTED by
  `bash -n`, because `[` is an ordinary command and a missing `]` is a runtime
  failure. The proof was itself measuring nothing.
- The restore drill reported ten of thirteen tables `ok` against a database it
  had never looked at: it connected to the restored cluster's default `postgres`
  database, where no table exists, so every "absent" expectation matched
  trivially. The backup now records WHICH database it counted, and the drill
  reads it rather than assuming.

### Defects found by tests, not by users
| Defect | Would have caused |
|---|---|
| The identity test harness never applied migration `0001` | Every service test ran against a schema with no `link_codes` table |
| The text `grade` column silently **assignment-casts** an integer `6` to `'6'` | Three files claimed the database enforced §8.2's "grade as a number is rejected". It cannot. Only the Zod contract can — and someone would eventually have deleted it (D-038) |
| `jsonb_typeof(x) = 'array' AND jsonb_array_length(x) = 4` raised a raw type error instead of a constraint violation | Postgres does not guarantee `AND` evaluation order. A malformed `options` payload produced an unmapped 500 rather than a named rejection (D-039) |
| Two overlapping `options` constraints made the rejection reason ambiguous | A three-option question was refused by the emptiness check, so the error named the wrong rule (D-039) |
| `chapter_mastery.chapter_id` and `rag_chunks.chapter_id` were unindexed foreign keys | Every `delete from chapters` sequentially scans both tables to apply the cascade (D-042) |
| pgvector's default `ef_search` of 40 caps an HNSW scan below the top-50 retrieval asks for | Retrieval silently receives 40 candidates where it asked for 50, which reads as a thin corpus rather than a misconfiguration (D-041) |
| `last_used_at` written from the database clock while renewal compared the injected clock | Silent session-renewal failure under any clock skew |
| Unhandled rejection on every readiness probe while the database is down | Noise during exactly the incident you are trying to diagnose |
| Rate-limit counter created without a TTL if `expire` failed mid-outage | Permanent lockout for whoever was first in that window |
| Concurrent link-code generation returned a raw pg error | 500 instead of a retryable 409 |
| `SET LOCAL` outside an explicit transaction is a silent no-op | The `ef_search` control test overrode nothing and returned 50 rows, looking exactly like "pgvector stopped capping" — a settings override that quietly fails to apply is the same class of bug the test exists to catch (D-049) |
| At seed scale the planner prefers an exact sort over the HNSW index | Both `ef_search` tests would have passed regardless of the setting, measuring nothing. `enable_seqscan = off` is what makes a small-corpus test say anything about a 16,000-row code path (D-049) |
| The password-corpus timing assertion was an absolute 500 ms | Failed at 558 ms under `--coverage` once four more database-backed suites ran in parallel. Worse, a real linear scan costs ~1.1 s, so any budget loose enough for a busy CI box also accepts the implementation the test exists to reject (D-055) |
| `pool-bulkhead.test.ts` still hardcoded its migration list — the D-046 defect, a second time | It surfaced only when `0004` added `users.tenant_id`, because Drizzle's `.returning()` projects every column the SCHEMA declares. Signup then asked for a column that database had never been given, and the error landed in `createUser` — several layers from the hardcoded list that caused it (D-072) |
| The breaker metrics bridge implemented `onTransition` but not `onRejected` | The transition count would have shipped without the COST count. A breaker open for four minutes rejecting three thousand calls looks identical to one that flapped twice with no traffic (D-072) |
| `JobRunner.stop()` awaited its own loop after the drain deadline expired | The loop was itself sitting on the job that had just been given up on, so the 30-second shutdown window logged "exceeded" and then blocked indefinitely — a deadline that reports being breached and honours it anyway (D-070) |
| `RecordingSleeper` resolves as a MICROtask | A poll loop built on it never yields to the macrotask queue, so `setImmediate` in a test never fires. The runner tests hung with a pegged CPU and no failing assertion. Production is unaffected — the hazard belongs to the fake (D-072) |
| The test container's default `max_connections` of 100 | Exceeded by five new database-backed suites. Symptom was `Connection terminated unexpectedly` in a `beforeAll`, landing on a different file each run: red, then green, with nothing wrong with the code (D-072) |

---

## 4. Remaining — backend

Build order from `docs/01-BACKEND-IMPLEMENTATION-PLAN.md` section 10.

| Step | Item | Days | Blocked by |
|---|---|---|---|
| ✅ 1-5 | Foundation, platform, identity, authz | — | — |
| ✅ — | Resilience hardening | — | — |
| ✅ 6 | **Corpus migration + `content` module** — module, migration `0001`, import script, all imported and verified | — | — |
| ✅ 7 | `embed` **real adapter DONE** (Voyage, guarded, boot-checked — D-123); **`llm` real adapter DONE too** (Anthropic Messages API, guarded, boot-checked — D-170). Both are fully unit-tested against a mocked HTTP layer and NEITHER is ever called by a test | — | keys only: `VOYAGE_API_KEY` for calibration, `LLM_API_KEY` to run Foxy against a real model |
| ✅ 8 | **`retrieval`** — module built, wired on the `ai` pool, no HTTP surface by design. Threshold ships `UNCALIBRATED` and INERT; the calibration harness is written | 0.5 | calibration blocked on `VOYAGE_API_KEY` only |
| ✅ 9 | `learner` | — | — |
| ✅ 10 | **`foxy`** — module, migration `0005_foxy`, five endpoints (one SSE), 203 tests. Guided interface: 3 modes × 6 fixed actions, no open chat (D-163). Abstention never calls the model and is a successful answer (D-165); citations are verified mid-stream and fabrications stripped before the student sees them (D-164); the safety classifier runs before the model (D-166); a trace row per turn, including abstentions. Runs on the SCRIPTED FAKE until a key exists | — | quality is blocked on `LLM_API_KEY` + threshold calibration; the module is not |
| ✅ 11 | **`practice`** — module, migration `0002`, 231 tests, atomic submission across two modules | — | — |
| ✅ 12 | **`parent`** — module, migration `0003_parent`, six endpoints, the weekly digest seam filled into `notify`. **The transcript is now LIVE**: `0005_foxy` created the tables the catalogue probe was waiting for, so reads return `source: 'foxy'` rather than `not_yet_available` (D-171) | — | — |
| ⬜ 13 | `billing` | 6 | Razorpay account |
| ⬜ 14 | `notify` | 3 | Resend key |
| ⬜ 15 | Integration suite + deployment | 5 | all |
| ✅ + | **Foundation hooks — roadmap section 8, all six** | — | — |
| ⬜ + | Pedagogy subset — see section 6 | 20 | — **unblocked**: the corpus, the concept graph and the misconception patterns are all in the database |
| ⬜ + | Feature-flag module (kill switches per resilience plan section 9) | 2 | — |
| ✅ + | **Wave 1 — half-done foundations closed** (tenancy, snapshot chain, three hardening items) | — | — |
| ⬜ + | Open items — see section 7 | 0.5 | — |
| | **Subtotal** | **~47** | |

## 5. Remaining — frontend

Build order from `docs/02-FRONTEND-IMPLEMENTATION-PLAN.md` section 11. **Steps 0, 1-4 and 6 are closed — 12 August 2026.** The frontend makes real network calls, and every shared component a screen will need exists before the first screen does.

| Step | Item | Days |
|---|---|---|
| ✅ 0 | **Foundation gaps — ALL FIVE DONE.** Auth/session strategy · error-code table · streaming client · token values · **CI gates**. Eleven gates exist; **six have been deliberately broken and observed to fail**, two cannot be proven until a build completes and CI runs, three are pre-existing. See D-340 | — |
| ✅ 1-4 | Tooling · tokens (scales CLOSED, lint enforces it) · **`components/ui` — Button, Input/Textarea/Select, Card, Badge, Skeleton, Dialog** · **`components/patterns` — LoadingState, EmptyState, ErrorState, PageHeader, StatCard, FormField, ConfirmDialog, EvidenceLabel, OfflineBanner** · `ProductShell` with both navigations and the offline banner. **92 component tests, every variant covered** | — |
| ✅ 5 | **i18n — both dictionaries, the switch, the Devanagari font, the user-facing-string lint rule.** Every user-facing string in the product now comes from a dictionary; a literal in JSX or in `aria-label`/`alt`/`placeholder`/`title` fails lint. **The visual-regression language axis is live**, so §10.7's four axes are all real | — |
| ✅ 6 | **API client · query keys · providers · session context** — one typed client, contracts generated from the backend, 401 clears the cache | — |
| ⬜ 7-8 | `auth` · `onboarding` — the screens exist and are presentational; they need wiring to the client | 5 |
| 🟡 9 | **`foxy`** — **`useFoxyStream` and the SSE parser are DONE, all 7 cases in plan §7 tested.** The chat UI is not built | 5 |
| ⬜ 10-11 | `practice` · `progress` | 8 |
| ⬜ 12 | `parent-dashboard` | 6 |
| ⬜ 13 | `billing` | 3 |
| ⬜ 14-15 | Responsive pass on a real device · accessibility · 2 E2E specs | 7 |
| | **Subtotal** | **~35** |

**Steps 1-5 looked slow and were not.** They took one session and every screen after this one inherits: three states that already announce themselves correctly, a form field whose label and error are wired by construction, a dialog with a real focus trap, and a confirm flow that cannot be double-pressed.

**Two client constraints are now encoded in components rather than remembered.** `EvidenceLabel` takes the four-value union and has no `value` prop at all, so a screen cannot render a mastery percentage through it (§9.1 forbids them). Nothing in the shared layer renders a failure in red: `StatCard`'s downward trend is `warning`, "Needs another session" is `info`, and `danger` is reserved for destructive actions somebody chose.

### What step 0 actually produced — 12 August 2026

| Piece | Where | The decision worth knowing |
|---|---|---|
| Contract bridge | `frontend/scripts/sync-contracts.mjs` → `src/lib/api/generated/` | The backend's `shared/contracts` and the `ERROR_CODES` union are COPIED and committed, with `--check` in a test. A direct import cannot work: `frontend/Dockerfile` copies `frontend/` alone, so `../backend/src` does not exist in the image — the build would fail on a path that resolves on every developer's machine |
| Error table | `src/lib/api/errors.ts` | §5.6, enforced. The switch is exhaustive over the GENERATED union, so a code the backend adds and the frontend does not handle is a type error. **A 403 on a POST is `action-blocked`, never a logout** — the backend returns 403 before 401 on state-changing requests, so reading it as an expired session signs out a user whose session is fine |
| Typed client | `src/lib/api/client.ts` | `credentials: 'include'` on every request, response validated against the Zod contract, non-2xx becomes a typed `ApiError`. It does NOT redirect on a 401 — that lives in `SessionProvider`, because §5.5 requires the query cache cleared in the same breath and a module-scope `window.location` can neither be tested nor clear a cache |
| Session | `src/lib/session/` + `src/app/providers.tsx` | One bootstrap query, three-valued status. `loading` renders a skeleton and NEVER a redirect. Any 401 anywhere clears the cache and redirects with `?next=` — on a shared family device an uncleared cache shows the previous user's data |
| Streaming | `src/features/foxy/` | `fetch` + `ReadableStream`, frames reassembled across chunk boundaries, unknown frame types ignored. **All seven cases in plan §7 are tests.** The bubble is created lazily on the first token, which is what makes "error before any token" an error state instead of an empty bubble |
| Tokens | `tailwind.config.ts` + `globals.css` | The scales are REPLACED, not extended, so an off-scale value does not exist. Tailwind is silent about that — it emits nothing and the element renders with no padding — so `architecture/spacing-scale-only` turns it into a build failure. It found five real breakages on the existing screens the moment it was switched on |

**Frontend tests: 10 → 236 unit and 28 end-to-end.** Type-check, lint, coverage floors, contract sync, deployable isolation and the whole browser suite are green.

### The CI gates — §10.7, closed 12 August 2026

`npm run gates` runs the five that need no build: type-check, lint, contract sync, deployable isolation, tests with coverage floors. The build-dependent ones (bundle budgets, Playwright, Lighthouse) run in `frontend-ci.yml` after `npm run build`.

| Gate | Proven to fail? |
|---|---|
| Lint — boundaries · arbitrary values · brand literals · **off-scale spacing** | ✅ **eleven real breakages found the moment the spacing rule ran**, including `pb-28` on the mobile-nav clearance and `size-9`/`size-10` on the avatar and logo — every one of them rendering with no size at all |
| Contracts in sync with the backend | ✅ appended a line to a generated file → red |
| Deployable isolation (`frontend/` ↔ `website/`, nothing climbing out of `src/`) | ✅ added an import of `../../../backend/src` → exit 1 |
| Coverage floors, per area (§10.5) | ✅ removed the primitives test → `components/ui` failed at 71% against 90% |
| Contrast, WCAG AA, **both themes** | ✅ lightened `--muted` → both dashboards failed |
| Visual regression | ✅ changed the parent `--brand` → the parent screenshot failed |
| Bundle budgets — 180 kB route, 120 kB shared, gzipped | 🟡 **arithmetic only** — ten unit tests over a synthetic `.next`. Never run against a real build: `next build` dies at worker teardown here (item 33) |
| LCP ≤ 2.5s · TBT ≤ 200ms, throttled 4G | ⬜ **NOT PROVEN.** Config and CI step exist; needs a completed build and a CI run |
| axe · type check · feature-boundary isolation | pre-existing, not deliberately broken this session |

**The two unproven gates are blocked on the same two things as everything else: a build that finishes on this machine, and CI ever executing.** Both are already §2's top items.

### Two defects the gates found in this session's own code

1. **An infinite 401 loop in the session provider (D-339).** `expire` called `queryClient.clear()`, which removes the BOOTSTRAP query — and that query has a live observer, so it refetched, 401'd, published, and expired again. Every cycle also called `router.replace`, so the login page never painted. The browser test caught it making thirty-odd requests; the jsdom test had asserted "fetched once" and settled before the second cycle. Fixed three ways: remove every query except the session one, a one-shot guard re-armed on a successful bootstrap, and no redirect at all from a public route.
2. **Eleven silently-broken layout utilities.** Closing the token scales made off-scale classes stop existing, and Tailwind emits nothing rather than warning — `pb-28` on the mobile bottom-nav clearance would have put the last card of every student screen underneath the nav bar. Found only because the lint rule was written at the same time as the closed scale.

### Two things step 0 uncovered that the plan had wrong

1. **`GET /me/profile` cannot be the session bootstrap, and a backend endpoint was added.** §5.5 named it as the single source of truth for "am I authenticated". It returns a STUDENT profile: a signed-in parent gets **403** (authz refuses before any row is read) and an un-onboarded student gets **404**, and neither response carries the role §5.5 needs for navigation and theme. A frontend reading "authenticated" out of a 403 is a frontend that signs people out on refresh. `GET /api/v1/auth/me` now exists on `identity`, returns the login shape, and 401s with no session — `backend/tests/integration/session-bootstrap.test.ts` pins all three states with identity AND learner mounted, which is the only configuration where the contrast is visible.
2. **The `proxy.ts` cookie presence check is impossible and was NOT built.** §5.5 specifies a Next proxy (the 16.x rename of middleware) doing a presence check ahead of the layout guard. The session cookie is host-only — `identity.plugin.ts` sets no `Domain` — so the Next server on `app.<domain>` never receives it, and the check would bounce every signed-in user to login. It would appear to work locally, where both apps are `localhost` and cookies ignore the port, which is the worst possible outcome. Making it work means widening the cookie to `Domain=.<domain>`, handing it to the marketing site and every future subdomain: a real security downgrade bought with a skeleton flash. Declined, recorded at the top of `session-gate.tsx`.

---

## 6. Pedagogy scope — three of nine DELIVERED, 10 August 2026

Nine capabilities were assessed. Full build is ~50 days; this subset is **20 days** and closes every one-way door.

| Capability | Scope agreed | Days | Status |
|---|---|---|---|
| Constrained Foxy | already the design — grounding, abstention, citation verification | 0 | — |
| **Misconception detection** | minimal: distractor-to-misconception codes, weekly aggregation | 6 | not started (D-077 blocks it — the data is NULL) |
| **Spaced-retention scheduler** | full — FSRS or SM-2, pure functions on the injected clock | 4 | **DONE** with `practice` |
| Anomaly rules | basic — reuse anti-cheat, add inactivity and mastery drop | 1.5 | **DONE** — `modules/signals` (D-131, D-132) |
| Rules engine | foundation only — versioned evaluator, rule version stamped on every decision | 2 | **DONE** — `platform/rules` (D-130) |
| Prerequisite concept graph | foundation only — schema plus hand-seeded chapter-level prerequisites | 3 | **DONE (reader)** — `modules/knowledge` (D-127, D-128, D-129) |
| Adaptive difficulty | seed — ladder on authored difficulty, plus full response logging | 2 | logging done with `practice`; ladder not started |
| Explainable priority scoring | seed — two candidate types, with real reason strings | 1.5 | not started |
| Independent mastery checks | held-out question pool reserved | 0.5 | **DONE** — 773 of 2,741 reserved (§8) |

Deferred until real usage data exists: full IRT calibration, concept-level graph extraction, multi-factor priority weights, scheduled mastery checks.

**What the graph reader found, and it changes the plan.** The 176 imported edges
were never read by anything; they are now. Two measurements matter:

- **The graph is internally sound** — all 176 prerequisite references resolve,
  zero dangling. Traversal over concept codes is exact.
- **Chapter projection CREATES three cycles that the concept graph does not
  have**, all in grade 7 mathematics, caused by a coarse (`math_7_ch5`) and a
  fine (`m7.geometry.triangles`) authoring scheme layered on the same chapters.
  Grade 7 maths is therefore 15-of-15 covered AND not orderable. See D-128.

Coverage, grades 6-10 mathematics and science (the whole corpus): **128 of 137
chapters carry a graph row, 93.4%.** Per grade/subject, chapters with a graph row
out of chapters in scope: maths 6 `10/12`, 7 `15/15`, 8 `14/14`, 9 `13/13`,
10 `14/15`; science 6 `12/12`, 7 `12/13`, 8 `13/13`, 9 `12/14`, 10 `13/16`.

**"Hand-seeded chapter-level prerequisites" is still the outstanding half** of
this line item. The reader, the coverage report and the cycle diagnosis exist;
authoring the missing edges — and deciding which of the two grade 7 schemes wins —
does not.

### billing module — 10 August 2026

Plan §8.8, built end to end: `createSubscription` · `handleWebhook` ·
`getEntitlements` · `cancelSubscription` · `getSubscriptionStatus`, plus
`platform/payments` (port, deterministic fake, Razorpay adapter) and migration
`0004_billing` (`subscriptions`, `payment_events`).

**The payer and the beneficiary are separate columns (D-150).** It is unresolved
whether this ships B2C or as a B2B school pilot in which schools pay and
per-parent subscriptions never exist. A single `user_id` column would have
answered that question by accident, so a subscription carries `subject_user_id`
(whose entitlements) and a payer (`user` or `school`) as independent facts, with
a database CHECK making any other combination unrepresentable. The decision
itself is ONE injected `PayerResolver` line at the composition root; a test
drives a school-paid seat for a student who never sees a payment page, and
another asserts that a resolver returning null REFUSES the checkout rather than
falling back to charging the actor.

**The webhook is at `/api/v1/webhooks/billing`, not the path §8.8 names
(D-151).** `POST /billing/webhook` sits outside the CSRF exemption pattern
`^/api/v\d+/webhooks/`, so it would have been 403'd for every genuine
server-to-server delivery — broken in production, green in development. Three
tests pin it: the chosen path IS exempt, the exemption is SCOPED (a live request
to `/api/v1/billing/webhook` is 403), and the exemption buys nothing without the
signature.

**All four webhook rules are structural rather than remembered.** The signature
check is the first statement of `handleWebhook`; the dedupe is `ON CONFLICT DO
NOTHING` on `(provider, provider_event_id)` — one statement, so two concurrent
deliveries cannot both pass, which a read-then-write allows; the subscription
update shares that transaction; and there is no `catch` in the handler, so a
failure becomes a 5xx and the provider retries. A test injects a mid-transaction
failure and asserts BOTH halves roll back and the retry then succeeds — the
failure that matters is the one where the event row survives, the retry is
deduplicated against it, and the subscription never activates: money in, no
access, no error anywhere.

**Expiry is computed, not swept (D-153), and entitlements are positive grants
(D-154).** A stored `active` whose period ended yesterday reports `expired` on
the next read with nothing having run in between; a test advances the clock and
watches access lapse. `free` is a real feature list rather than the absence of a
denial, so a lost grant grants NOTHING instead of silently handing out the free
tier.

**Five guard mutations were run against the source and all five went red
(D-152)** — including the D-125 shape (`authoriseSubscription` echoing the
actor's own tenant), which billing has no second layer to mask. They are
institutionalised in `billing.authz-mutation.test.ts`, which asserts each break
is OBSERVABLE rather than merely that the guard exists.

**The Razorpay adapter is fully unit-tested and never called (D-156).** There is
no account and no key: every HTTP call goes to a recording fake `HttpClient`,
and the only half exercised against real cryptography is `verifyWebhook`, which
makes no network call. The deterministic fake shares `signature.ts` with the
real adapter, so "a forged signature is rejected" is a claim about real HMAC
rather than about a stub that was told to say no.

---

## 7. Open items and known gaps

### Agreed, not implemented
| # | Item | Source | Effort |
|---|---|---|---|
| 19 | **`foxy`'s ANSWER QUALITY is entirely unmeasured, and no test in the suite can measure it.** Every foxy test runs against the DETERMINISTIC SCRIPTED FAKE, which does not read the prompt. That proves the pipeline — ordering, abstention, citation verification, streaming, the trace, every failure branch — and says NOTHING about whether an answer is correct, age-appropriate or well-grounded. Two things unblock it and neither is code: `LLM_API_KEY` (set it, and `createContainer` picks the real adapter with no other change), and `VOYAGE_API_KEY` for the retrieval calibration, without which `ABSTAIN_THRESHOLD` is INERT and **Foxy will effectively never abstain on a real corpus** — the grounding rail that the whole design rests on is present, wired, tested and currently set to a value that filters nothing | D-165, D-170; retrieval's `abstain-threshold.ts` | keys, then 1 d of eval |
| 20 | **The daily usage limit is enforced per plan, but every account resolves to `free`** — and this is now the ONLY thing between a paying customer and the limits they paid for, because `billing` itself is wired. `app/routes.ts` still passes `readPlan: () => Promise.resolve(null)`, which the service reads as `free` (20 messages/day). **Deliberately not closed with the rest of the wiring**, because it is not a one-line bind: `foxy`'s `PlanReader` is `(studentUserId) => Promise<FoxyPlan | null>` and takes NO ACTOR, while `billing.getEntitlements(actor, subjectUserId)` requires one and runs `authoriseSubscription` on it. Binding them needs either a widened `PlanReader` or a deliberate system actor, plus a decision about how the billing catalogue (`free`/`monthly`/`yearly`) maps onto `FoxyPlan` (`free`/`plus`) — the honest mapping is `hasFeature(entitlements, 'foxy.unlimited')`, since that entitlement is named for exactly this. Guessing either half silently is how a customer pays and gets nothing | §8.5, D-175 | 1 h |
| 21 | **The usage-counter day rolls over at UTC midnight, i.e. 05:30 IST.** Deliberate and imperfect: a timezone-aware key needs per-user timezone storage, which does not exist — the same gap D-069 records for job scheduling. 05:30 lands in the middle of nobody's study session, so it is the cheapest wrong answer available. Recorded so the next person changes it deliberately rather than discovering it | `foxy/domain/usage.ts` | with per-user timezones |
| ~~22~~ | ~~**`0004_billing`'s journal `when` is BELOW `0003_parent`'s** (1786374108357 vs 1786700000000). That is exactly D-109: drizzle skips a migration whose recorded timestamp precedes the last applied ledger row, and reports "Migrations applied." while applying nothing.~~ **CLOSED 10 August.** Corrected to **1786750000000**. The defect was REPRODUCED first, on a scratch database primed to `0003`: `subscriptions` and `payment_events` absent, `0005` applied over the hole, exit code zero. Re-verified after the fix from empty and from a primed ledger — six ledger rows, both tables present. Enforced from now on by `tests/integration/migration-journal-order.test.ts`, proved to fire by reverting the value. **The round-trip test could not have caught it**: it applies by `idx` and never reads `when` | D-109, D-173, D-174 | done |
| ~~17~~ | ~~**`billing` IS BUILT AND NOT WIRED.**~~ **CLOSED 10 August — all four parts landed.** (a) `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` / `RAZORPAY_WEBHOOK_SECRET` are in `.env.example`; (b) `Container.payments` exists, wrapped in `resilience.guard('payments')`, choosing Razorpay when all three credentials are set and the deterministic fake otherwise, **with a production boot refusal that names WHICH credential is missing** — `RAZORPAY_PLAN_IDS` is deliberately excluded from that check because an unmapped plan code is a LOUD failure at checkout, and only the silent failure needs a gate; (c) `createBillingModule` is in `buildModules` on the `core` pool, with `readTenantOfUser` reading `users` through identity and a `resolvePayer` carrying the B2C answer keyed on `subjectUserId` rather than `actor.userId`; (d) `await modules.billing.registerRoutes(app)` is in `registerRoutes`. `routes.test.ts` pins that driving `registerRoutes` with billing alone produces `/api/v1/webhooks/billing`, and `wiring.test.ts` pins the boot refusal in five cases. The module harness stays local for a different reason now: it needs the CONCRETE `FakePayments` to sign deliveries, which the port cannot give it | D-150, D-151, D-175, D-176 | done |
| 18 | **Erasing a paying user is not possible, by design.** Every foreign key out of `subscriptions` is `ON DELETE RESTRICT`, because a receipt that vanishes when somebody deletes an account is a reconciliation hole and a GST-invoice hole. So account erasure for a billed user becomes an ANONYMISE operation, and that operation does not exist. Not pre-built: writing it before a single subscription exists would be guessing at a retention policy nobody has set | D-155 | 1 d, with the policy |
| 19 | **No Razorpay account exists, so the HTTP half of the adapter is unproven against the live API.** Every call is driven by a recording fake `HttpClient`; the signature half needs no vendor and IS proven. What remains blocked on real credentials: that live responses carry `id` and `short_url` where asserted, that the idempotency header is honoured, that a real `x-razorpay-signature` verifies against a dashboard-issued webhook secret, that Razorpay plan ids map as configured, and the end-to-end activation of one real subscription in test mode. The adapter NARROWS every field rather than casting, so a shape mismatch fails loudly at the boundary instead of writing a subscription row no webhook can reconcile | D-156 | 2 h, once a key exists |
| 3 | Leetspeak normalisation cannot see a substitution in the first character (`8utterfly` is accepted). Documented and asserted, not hidden | D-018 follow-up | — |
| 4 | `questions` cannot enforce "all four options are DISTINCT" — a CHECK may not contain a subquery, and distinctness needs aggregation. It is a `content` module rule. The module now EXISTS, so it finally has somewhere to live: apply it on the write path when one is built, or as an import validation | D-039 | 30 min |
| 8 | **`audit_log` and `notifications` keep NULLABLE tenants, deliberately.** Neither is student-owned data reached through `assertCanAccess`, and — the deciding point — neither has a writer that knows a tenant: `audit_log` records system actions whose actor is null by design, and the in-app channel is handed a recipient and nothing else. A NOT NULL column whose only writer relies on the column default is theatre of exactly the kind D-073 rejects. **The mechanism when it is done:** resolve the tenant from the recipient / the actor as a scalar sub-select in the INSERT, and leave `audit_log` nullable for genuinely actor-less rows | D-084 | 2 h |
| 9 | **Moving an account between tenants MUST revoke its sessions.** A student reaching their own data short-circuits the tenant lookup and trusts the session's tenant — safe today (the data moves with them, and a parent gets no short-circuit) but it makes session revocation a hard requirement of any account-moving code, the same way a password reset revokes sessions. Nothing moves accounts between tenants yet | D-083 | 1 h, with the feature |
| 11 | **1,199 of 4,686 imported chunks are exact text duplicates** — the same NCERT passages ingested twice under two `chapter_title` conventions. The effective distinct corpus is **~3,487 chunks**, and duplicates compete for the same top-k slots (the manual vector query returned one passage twice in its top six). NOT deduplicated by the import, deliberately: which copy is canonical is a retrieval-quality decision that belongs with threshold calibration, where it can be measured | D-108 | 1 day, with step 8 |
| 12 | **20 chunks carry a NULL embedding and are invisible to vector search.** Ids in `.corpus-extract/reports/chunks-without-embedding.txt`. They import with NULL and are reachable by full-text search; **no vector was fabricated.** Needs `VOYAGE_API_KEY` and the `embed` adapter | D-078 | 1 h, with step 7 |
| ~~17~~ | ~~**`signals` cannot be constructed until `practice/index.ts` exports its anti-cheat floor.**~~ **CLOSED 10 August.** `practice/index.ts` now exports `MIN_AVERAGE_MS_PER_QUESTION`, `SAME_ANSWER_MIN_QUESTIONS`, `ANTI_CHEAT_REASONS` and `validateAttempt`, additively — `practice.service.ts` still imports them from `./domain/anti-cheat` directly and no check, threshold or ordering changed. **The no-default property is intact**: `signals`' `AntiCheatEdge` is still required, so a missing wiring is still a compile error rather than a second copy of `3_000`. The edge built in `buildModules` discards the FAILURE REASON on purpose — that belongs to `practice`, which writes it to `practice_sessions.invalid_reason` | D-131, D-177 | done |
| 18 | **Grade 7 mathematics cannot produce a learning path, and the data is not corrupt.** Two authoring schemes — coarse `math_7_chN` and fine `m7.topic.detail` — are layered on the same chapters and disagree once projected onto chapters, producing 3 cycles. Both edges in each cycle are TRUE statements about concepts, so the code reports the closed path rather than dropping one. **Somebody has to decide which scheme wins for grades 7 and 8 maths** (the only two carrying the fine scheme; 21 and 19 rows). Until then `getGraphCoverage('7','mathematics').orderable` is false while coverage reads 15/15, and `canPlanFor` still works for the chapters not on a cycle | D-128 | half a day of authoring |
| 19 | **9 of 137 chapters carry no `concept_graph` row at all** — grade 10 science 3, grade 9 science 2, grade 6 maths 2, grade 7 science 1, grade 10 maths 1. They are NAMED by `getGraphCoverage`, not just counted, so a caller can tell "this chapter is invisible to the graph" from "this chapter has no prerequisites" | D-129 | with item 18 |
| 13 | **The question-level pedagogy layer is confirmed empty in the imported data** — `hint_level_1`, `hint_level_2`, `hint_level_3` and `solution_steps` are NULL on all 3,791 source questions, and `question_hi` on 3,581 of them. `distractor_misconceptions` is NULL on all 2,741 imported questions: the 57 misconception patterns exist but nothing links a pattern to a distractor. Generation, scoped to the pilot chapters, is unavoidable | D-077 | section 6 |
| 14 | **`misconception_patterns` has no Hindi description, and the source has no such column** — not "usually null", it does not exist. A P7 gap that needs translations written, not a column added | D-098 | with the pedagogy subset |
| 15 | **The dev database's drizzle ledger predates the baseline collapse**, so `db:migrate` skipped `0001` on timestamp order while reporting success. Worked around by setting 0001's journal `when` above the last applied row. Any other database created from the 0000-0008 chain has the same hazard | D-109 | 30 min, if another such database exists |
| 16 | ~~The development database is still on `0001`~~ **RESOLVED 11 August.** The old database was a fossil of the superseded chain. A clean `foxxy_dev` was provisioned, 7 migrations verified table by table, corpus re-imported. The armed hazard is gone | resolved | 15 min |
| 10 | **Per-migration drizzle snapshots for `0004`-`0007` do not exist and cannot be reconstructed** — those schema states were never committed. The chain is LINKED (`0008.prevId` = `0003.id`) and `db:generate` emits nothing, which is the property that matters; `drizzle-kit check` passes and is exposed as `npm run db:check`. The alternative that would give a gapless chain is to collapse `0000`-`0008` into one baseline migration plus one snapshot — **a user decision, since it rewrites already-applied migrations** | D-081 | 2 h, if chosen |

| 21 | **The backup volume is on the same host as the data it protects.** WAL archiving plus nightly base backups cover corruption, a bad migration and a lost data volume — they do NOT cover losing the host. No off-site target is configured, deliberately: a half-configured object-store credential is worse than an honest gap, because it looks like a solved problem. Needs an encrypted `restic`/`rclone` sync to a different failure domain, and that target must then be included in the monthly drill — an off-site backup never restored FROM off-site is the same defect one level up. Until then: **a host loss is a data loss** | D-149 | 1 day |
| 22 | **CODEOWNERS is documentation until branch protection requires it.** Two of the three layers protecting the proxy configuration are mechanical (a read-only mount, an allow-list deploy script); the third is a review requirement that depends on "require review from Code Owners" being enabled in the repository SETTINGS, which is not a file and is not in this repository. The placeholder team handles must also be replaced — a CODEOWNERS naming a team that does not exist matches nothing and requires no review | D-143 | 10 min, in the repository settings |
| 23 | ~~"The notification reached NOBODY" has no metric~~ **RESOLVED 11 August, D-314.** `notify.undeliverable` is emitted once per notification, tagged by kind only, with a rule watching it at threshold 1 | resolved | 15 min, with the `notify` module |
| 24 | **The SSE proxy matcher is `/api/v1/foxy/*`, not the exact stream path**, because `foxy` was being built while the proxy was written. Once the route is final, narrow it — and run the SSE smoke check in `docs/runbooks/deploy-rollback.md` §1.2 afterwards, because a wrong matcher fails as BUFFERED STREAMING, which nobody attributes to a proxy | D-142 | 15 min, once `foxy` ships |

**Closed on 10 August:** item 1 (CORS read/write split — D-082), item 2
(`POST /links/code` rate limit — D-085), item 5 (global authenticated rate limit
— D-080), item 6 (drizzle snapshot chain — D-081, with the residue above as item
10), item 7 (`tenant_id` NOT NULL and the strict guard — D-073).

**Closed by the composition-root integration, 10 August:** the `0004_billing`
journal `when` (D-173/D-174 — reproduced, fixed, and now pinned by a test that
was itself proved to fire), `billing` wiring including the `payments` port and
its production boot refusal (D-175/D-176), the `practice` anti-cheat export that
made `signals` constructible (D-177), and `knowledge` + `signals` construction on
the `core` pool. **One residue, stated rather than closed quietly:** `foxy`'s
`readPlan` is STILL `() => Promise.resolve(null)`, so every account still
resolves to the `free` daily limit even with a live subscription — see item 20,
which is now the only thing standing between a paying customer and the limits
they paid for.

**Closed on 9 August:** the `distractor_misconceptions` shape (jsonb object keyed
by option index, migration `0003`, D-048) and `hnsw.ef_search` (set to 100 on the
`ai` pool from config, D-049).

### Handed off by the 11 August waves — not yet done

Each was reported by the agent that found it and left deliberately, because it sat outside that agent's ownership.

| # | Item | Owner | Effort |
|---|---|---|---|
| 25 | **The `Embeddings` row of the degradation matrix is FALSE.** `docs/04-RESILIENCE-PLAN.md` section 6 claims keyword-only fallback; `retrieval.service.ts:52-70` deliberately throws instead, and says so. Measured: **HTTP 502, no answer, no metric.** Section 11 calls every row a testable requirement. Either update the matrix or build the fallback - the current state is a documented guarantee the code contradicts | ai-engineer | 1 d |
| 26 | **`parent`'s "recoveries" effort signal is now structurally zero.** It counts `answer_changed = true AND is_correct = true`; with answers immutable (D-281) that can never happen. This is a **reduction in reported signal and an increase in its truthfulness** - the old values came from unverifiable client testimony - but the digest will flatten, and nobody should hunt it as a regression | assessment | 0.5 d |
| 27 | **`content.listChapters` takes one subject**, so `getTodaysMission` still issues one query per subject. The latency is fixed; the query count is a `content` API shape | backend | 0.5 d |
| 28 | **`readWorkerLiveness` is fixed but `/health/deps` still does not use it.** It no longer throws and is the correct per-worker, status-filtered query. The collector was rewired; the health endpoint was not | architect | 0.5 d |
| 29 | **`container.authz` fails loudly rather than correctly.** `LinkStatusReader` is synchronous and every real link status is an async read, so a correct reader is not expressible at that seam. It now throws a named error instead of silently denying every parent-child relationship. The durable fix is an async reader, or deleting the member | architect | 1 d |
| 30 | ✅ **CLOSED — 12 August.** All five foundation gaps are built and tested, CI gates included. Eleven gates exist and **six have been deliberately broken and observed to fail**; two (bundle budgets against a real build, Lighthouse) cannot be proven until item 33 and a CI run are resolved. See §5 and D-340 | frontend | — |
| 31 | **The frontend lint rules are bypassed by their own idiom.** `staticClassName()` only unwraps a bare literal, so `className={cx('bg-purple-600')}` is not flagged - and `cx()` is how every conditional and variant style is written. **`architecture/spacing-scale-only` (12 August) shares the same helper and therefore the same hole**, which matters more for it: a missed brand literal renders the wrong colour, a missed off-scale spacing utility renders NO spacing at all, because the scale is closed | frontend | 0.25 d |
| 32 | ✅ **CLOSED — 12 August.** `@vitest/coverage-v8` installed and §10.5's floors enforced PER AREA (pure functions 95, hooks 85, components 80, primitives 90) rather than as one global number a half-tested codebase can satisfy. Proven by deleting a test file: `components/ui` dropped to 71% and the gate failed | frontend | — |
| 33 | **`next build` fails on this machine**, at worker teardown (`kill EPERM`, Next 16.3 + Windows). **The bundler is ruled out — 12 August:** `--webpack` fails identically, and gets FURTHER (it completes "Collecting build traces"; the Turbopack run never reaches it). So every artifact-producing phase succeeds and the crash is in the worker pool afterwards. `.next/` is written, `.next/standalone/` is not, and that is what the Dockerfile consumes. Next avenue is the build-worker pool or building inside the Linux image | architect | ? |
| 34 | ✅ **CLOSED — 12 August.** Onboarding submitted `english`/`hindi` where the contract accepts `en`/`hi`, and offered grades 6-10 where the syllabus and the database CHECK run to 12. Both now come from the GENERATED constants, so the form cannot offer a value the profile refuses. The test that pinned the 6-10 list — asserting Grade 11 was absent — was protecting the defect, and now asserts Grade 12 is present | frontend | — |
| 35 | **`UserProfile.role` widened to ten values** (D-293). No byte changes today, but a frontend `switch` on `user.role` that was exhaustive over two cases now needs a default | frontend | — |
| 36 | **The resend-verification endpoint has no client.** `EmailNotVerifiedError` already carries `reason: 'EMAIL_NOT_VERIFIED'`, so the offer is now implementable | frontend | 0.25 d |
| 37 | **`worker-main.ts`'s own shutdown path is untested** - its `stopping` guard, both `catch` blocks and `process.exit(0)`. `worker.ts` went 0% to 90.72%; its entry point did not follow | testing | 0.5 d |
| 38 | **Breaker, concurrency-limiter and LLM-timeout service tests are now reachable for the first time** - the harness passes guarded ports as of D-326. Nothing exercises them yet | testing | 1 d |
| 39 | **`platform/mail` needs a real `ops-alert` template.** The runbook path currently survives by being appended to the body; a typed template makes that redundant | ops | 0.25 d |
| 40 | **`shared/constants/roles.ts` prose is wrong** - it says `roleSchema` "is built from `SIGNUP_ROLES`"; it is a hand-written `z.enum`. They agree today and a test pins it, so this is a documentation defect on the one constant whose separation keeps `super_admin` off a public dropdown | backend | — |

### Deliberately deferred, with the unblocking condition
| Item | Waiting on |
|---|---|
| ~~Global 100-per-minute authenticated rate limit~~ | ~~a second module having routes~~ — **DONE 10 August.** A shared `app/plugins` hook every module inherits (D-080) |
| ~~Expired-session sweeper~~ | ~~the worker process~~ — **DONE 9 August.** The worker exists and this is its one real job |
| Degradation-matrix tests (resilience plan section 6) | the modules they cover |
| Reset-token invalidation when a password changes by another route | normal follow-up |
| Repeated-failed-login lockout and notification | normal follow-up |
| ~~**`tenant_id` becomes NOT NULL and the guard denies on a missing tenant**~~ | **DONE 10 August**, migration `0008` (D-073). It was mechanical exactly as predicted — the compiler listed every call site, and every one of them was a test |
| Parent weekly digest job · retention SCHEDULER JOB | the `parent` module. (`practice` has landed: the SM-2 arithmetic, `practice_retention` and the due-review branch of Today's Mission all exist and are exercised. What is missing is a background job that NOTIFIES a student a review has fallen due — today the mission surfaces it when they open the app.) Deliberately NOT stubbed — a registered handler that does nothing lets a job succeed without doing the work, which is worse than the "no handler" error the runner raises |
| Timezone-aware job scheduling (`09:00 Asia/Kolkata`) | the parent digest. The current scheduler expresses daily-or-coarser only, keyed by UTC date (D-069) |

---

## 8. One-way doors — CLOSED, 9 August 2026

All three were structurally closed by migration `0002_learner_content`, and
migration `0003_misconception_object` settled the one shape question that was
left open (D-044 → D-048). The columns and the table exist; **the data does not
yet, and that is the part still outstanding.**

| Door | Status | What remains |
|---|---|---|
| **Tag every distractor with a misconception code** | Column `questions.distractor_misconceptions` is a jsonb OBJECT KEYED BY OPTION INDEX (migration `0003`). The CHECK enforces exactly 3 entries, keys in "0".."3", and the correct option's key ABSENT. The shape question raised by D-044 is now SETTLED — see D-048 | Authoring the codes. NULL is permitted and honest until then |
| **Reserve ~30% of each chapter's questions as check-only** | **DONE, 10 August 2026.** `is_held_out` is true on **773 of 2,741** imported questions — ~30% of each of the 81 chapters that carry at least 15 valid ones, and NONE below that. Chosen before a single question was ever served, which was the requirement. Guarded twice against a re-run releasing any of them (D-104) | Nothing. The door is shut |
| **Log every response** | **DONE, 10 August 2026.** The table arrived three build steps early; `practice` now writes it on every submission, and migration `0002` renamed it to `practice_responses` with the `session_id` D-057 called for. `authored_difficulty` is frozen at answer time, and all five evidence columns are written and asserted column by column out of the database | Nothing. The door is shut |

**Now checked, 10 August 2026.** The precondition was real and the answer is
mixed: of 137 chapters, **81 carry at least 15 valid questions** and got a
reserve; the other 56 did not, and are flagged not-demo-ready rather than given
a token two-question reserve that would measure nothing. D-079's decision stands
— thin chapters get MORE QUESTIONS GENERATED, not a smaller reserve — and the
per-chapter counts are in `.corpus-extract/reports/chapter-readiness.ndjson`.

---

## 9. Facts worth remembering

| | |
|---|---|
| Postgres runs on **port 5433**, not 5432 | a native Postgres holds 5432 on this machine (D-009) |
| Corpus embeddings are `voyage-3`, 1024 dimensions | matches the query path, so **no re-embedding**. `rag_chunks.embedding` is `vector(1024)` for exactly this reason. Swapping to self-hosted BGE-M3 is ~1 day, but only once the eval harness exists |
| **Grades are text, and the database can only enforce the VALUE** | `insert ... values (6)` with a bare integer SUCCEEDS and stores `'6'` — Postgres assignment-casts integer to text silently. The CHECK still refuses `'5'`, `'13'`, `'05'`, `'6 '`. "Grade as a NUMBER is rejected" (§8.2) is enforceable ONLY by the module's Zod contract (D-038) |
| **Postgres does not guarantee `AND` evaluation order in a CHECK** | `jsonb_typeof(x) = 'array' AND jsonb_array_length(x) = 4` raises a raw type error on a non-array instead of naming the constraint. Use `CASE`, which does guarantee short-circuiting (D-039) |
| pgvector's default `hnsw.ef_search` is **40**, and an HNSW scan returns no more rows than that | §8.4 asks for the top 50. Measured on 0.8.6: ef_search 40 → 40 rows, ef_search 100 → 50. Silently under-retrieving reads as a thin corpus (D-041). **Now SET to 100 on the `ai` pool** as a connection parameter, from `DATABASE_HNSW_EF_SEARCH` (D-049) — keep it ≥ the largest LIMIT any retrieval query uses |
| `SET LOCAL` outside an explicit transaction is a **silent no-op** | It warns and does nothing. A test that overrides a setting without a `BEGIN` measures the default while appearing to measure the override (D-049) |
| At seed scale the planner does **not** choose HNSW | It bitmap-scans or sorts exactly — faster and perfectly accurate. Any small-corpus test of index behaviour needs `enable_seqscan = off`, or it says nothing about the 16,000-row path (D-041, D-049) |
| A module reaches another module through an **injected dependency**, never an import | `app/routes.ts` is the complete cross-module dependency graph. `learner` needs identity's session validator and link status; it imports neither (D-051) |
| **A source shape is a MEASUREMENT, never an expectation** | Four of the five `Source*` types were written from reconnaissance notes and four were wrong. Three failed SILENTLY — `concept_name` for `title` skipped all 639 concepts and reported them as rejected-for-no-name; `misconception_code` for `pattern_code` skipped all 57. "0 rows imported" is indistinguishable from "the source has none". Scan the keys of the real file (D-098) |
| **The corpus import's primary keys are UUIDv5 of the source id, and the namespace is FROZEN** | `questions` and `rag_chunks` have random-uuid defaults and no source column, so a plain INSERT duplicates the corpus on every re-run with nothing violated. Changing `CORPUS_ID_NAMESPACE` does not renumber the rows — it inserts a second complete copy beside them (D-102) |
| **`concept_graph.concept_code` does not join to `chapter_concepts`** | Two independently-generated vocabularies; `chapter_concepts` has no code column at all. The ONLY link is `(grade, subject, chapter_number)`. Adding the plausible foreign key would delete 37 of the 57 misconception patterns, which are human-authored and now unrecoverable. A test asserts no such foreign key exists (D-105) |
| **`db:migrate` printing "Migrations applied." does not mean it applied anything** | Drizzle skips a migration whose journal `when` is older than the last applied ledger row. The dev database still carried the 0000-0008 ledger, so 0001 was silently skipped. Check the catalogue, not the exit code (D-109) |
| `rag_chunks.search_vector` is a **generated column** | Never write to it, and the corpus import must NOT map the source column of the same name (D-040) |
| A pool is obtained by **naming the module** — `container.poolFor('learner')` | There is no general-purpose `container.db` any more. It aliased the `auth` pool, and the second module to take it would have silently competed with login for its ten connections (D-045). The **worker is not a module** and takes `container.pools.worker` directly — adding it to `ModuleName` would let a module ask for the worker pool |
| **`tenant_id` is nullable and the guard is deliberately lenient** | It denies only when BOTH sides carry a tenant and they differ. That is correct while one tenant exists and WRONG the moment a second does — see the exit condition in section 7 and D-061. The column existing without the enforcement would be theatre; the enforcement without the column would be impossible |
| **`users.role` accepts ten values; signup accepts two** | `PLATFORM_ROLES` and `SIGNUP_ROLES` are separate constants and `roleSchema` is built from the second. "Simplifying" that to `PLATFORM_ROLES` compiles, inserts, and hands the internet a `super_admin` dropdown. Only the test notices (D-062) |
| **`audit_log` refuses DELETE — clear it with TRUNCATE** | A trigger raises on UPDATE and DELETE (SQLSTATE `2F004`). TRUNCATE is left available on purpose: it needs table ownership, so it is a DBA operation, and it is the only legal way the table can ever shrink. Test harnesses truncate it (D-063) |
| A job's `idempotency_key` must come from **the work**, never a clock | `(kind, idempotency_key)` is UNIQUE, and that constraint is the entire deduplication mechanism. A timestamped or random key makes every enqueue a new job and silently removes it (D-069) |
| `RecordingSleeper` resolves as a **microtask** | A poll loop built on it never yields, so `setImmediate` in a test never fires and the suite hangs with no failing assertion. Use a sleeper that yields a macrotask for loop tests (D-072) |
| Test harnesses **discover** migrations and cross-check the drizzle journal | Never hardcode a migration list. That is exactly how the identity harness ran an entire suite against a schema missing a table (D-046) |
| ESLint `no-restricted-imports` uses **gitignore globs, not minimatch** | `'!(index)'` reads as a negation and matches nothing. Verify every boundary rule fails on a violation (D-005) |
| An unauthenticated cross-site POST returns **403 before 401** | deliberate — the CSRF verdict must not depend on who the caller claims to be. The frontend must handle 403 for "session expired" on POST |
| Retrieval thresholds must be **measured, never guessed** | 50 known-good plus 20 off-syllabus questions, plot both distributions, place the threshold between them, record the measurement beside the constant |
| Only three external services are approved | LLM API · Voyage embeddings · Resend, plus Razorpay which is regulated. Everything else is self-hosted — `docs/00-ARCHITECTURE.md` section 0 |
| The database is the **only** true single point of failure | every other dependency has a degradation path — resilience plan section 6 |
| A backup is not a backup until a restore has been demonstrated | monthly drill, non-negotiable |

---

## 10. Document map

| File | Contents |
|---|---|
| `PROGRESS.md` | **this file** — state, next action, remaining work |
| `docs/00-ARCHITECTURE.md` | third-party policy, foundations, module map, corpus migration, what is reused from the old repo |
| `docs/01-BACKEND-IMPLEMENTATION-PLAN.md` | stack, structure, schema, ports, **full auth specification**, testing, build order |
| `docs/02-FRONTEND-IMPLEMENTATION-PLAN.md` | structure, SOLID applied to React, reuse tiers, state, streaming client, i18n, testing, build order |
| `docs/03-DECISION-LOG.md` | **every decision the plans did not specify, or that contradicts them.** Read before assuming a plan is current |
| `docs/05-ROADMAP.md` | **MVP plus five phases across the first year** — teacher, WhatsApp, voice, mobile, school roles, white-labelling. Includes the foundation hooks that must land in the MVP or become expensive |
| `docs/04-RESILIENCE-PLAN.md` | failure model, bulkheads, timeouts, circuit breakers, degradation matrix, health checks, extraction triggers |
| `docs/05-FRONTEND-SEPARATION-PLAN.md` | marketing/product domain split, Payload publishing, cookie/CORS and SSE proxy rules, pipeline and data isolation |

---

## 11. Session log

| Date | Work | Tests after |
|---|---|---|
| 7 Aug 2026 | Plans written: architecture, backend, frontend | — |
| 7 Aug 2026 | Foundation, platform layer, identity schema, authz boundary | 164 |
| 7 Aug 2026 | Identity module — full auth and parent-child linking | 392 |
| 8 Aug 2026 | Resilience plan; platform hardening — pools, breakers, timeouts, health, shutdown, `link_codes` | 593 |
| 8 Aug 2026 | Identity hardening — link-code repoint, password corpus, rate-limit fallback, origin check, `APP_URL` | 680 |
| 8 Aug 2026 | Git repository relocated to project root so `docs/` is versioned | 680 |
| 9 Aug 2026 | `learner` + `content` schema, migrations, fixtures, dev seed | 756 |
| 9 Aug 2026 | `learner` + `content` modules; misconceptions re-keyed by option index; `ef_search` set to 100 | 926 |
| 9 Aug 2026 | D-056..D-060 settled — transaction ownership, response-table merge, canonical index, chunk linkage | 926 |
| 9 Aug 2026 | `learner` + `content` schema, migration `0002`, all three one-way doors, per-module pools (D-030 closed), migration-discovering harnesses, fixtures + `db:seed` | 756 |
| 9 Aug 2026 | `learner` and `content` modules in full; migration `0003` (misconceptions keyed by option index, D-044 closed); `hnsw.ef_search` on the `ai` pool (D-041 closed); `parseInput` to platform; composition-root test | 926 |
| 10 Aug 2026 | **Wave 1 — the half-done foundations closed.** `tenant_id` NOT NULL + strict guard + tenant on every insert path (migration `0008`, D-073 resolved); drizzle snapshot chain rebuilt, `db:generate` emits nothing (D-081); global 100/min authenticated rate limit applied (D-080); `POST /links/code` bounded (D-085); `CORS_ORIGINS` split into read/write (D-082); the hardcoded-migration-list pattern made a lint error after a THIRD instance (D-075 resolved) | 1,142 |
| 10 Aug 2026 | **The corpus is imported.** Migration `0001_pedagogy` (3 tables, no tenant, forward/rollback/re-apply proven); `scripts/import-corpus.ts` streaming 66 MB twice, deterministic UUIDv5 keys, reconciling deletes, **idempotency proven by digest not asserted**; `scripts/clear-content.ts`; 137 chapters / 4,686 chunks / 2,741 questions / 639 concepts / 176 edges / 57 patterns / 773 held out; both retrieval paths verified by hand. **Four of the five source shapes were wrong and three failed silently** (D-098). D-098..D-109 | 1,453 |
| 9 Aug 2026 | **Foundation hooks — roadmap section 8, all six.** Migrations `0004`-`0007`: tenancy, role enum + schools/classes stub + `audit_log`, evidence capture, notify/metrics/jobs. New platform modules `pii`, `metrics`, `audit`, `notify-channel`, `jobs`. **The `worker` process**, with the expired-session sweeper. Tenant isolation enforced in `platform/authz`. D-061..D-072 | 1,077 |
| 10 Aug 2026 | **Wave 1 - foundations closed.** `tenant_id` NOT NULL with a strict guard (D-073); drizzle snapshot chain rebuilt; global 100/min authenticated limiter at `onRoute`; `POST /links/code` limited; `CORS_ORIGINS` split into read and write allow-lists. Third and fourth instances of the hardcoded-migration-list defect found and the pattern made unavailable by lint. D-080..D-086 | 1,142 |
| 10 Aug 2026 | **Frontend foundation review.** Five mechanism gaps closed in the plan before any code: auth/session strategy, backend-error-to-UI table, the SSE-over-POST correction (`EventSource` is GET-only), design token values, and CI gates with enforced numbers. Doc numbering collision resolved. D-087..D-090 | 1,142 |
| 10 Aug 2026 | **Wave 2a - migration collapse.** `0000`-`0008` collapsed to a single baseline; old chain kept in `drizzle/_superseded/` | 1,142 |
| 10 Aug 2026 | **Wave 2b - `notify` module.** Kind-to-channel table, worker delivery, dead-letter, quiet hours, digest scheduler skeleton. **A cross-tenant hole was found in 3 of 4 methods** - the guard compared `actor.tenantId` with itself. D-091..D-094 | 1,396 |
| 10 Aug 2026 | **Corpus extraction.** MCP diagnosed as unable to carry 58 MB of vectors through a context window; extracted instead by keyset pagination over a session-pooler connection. 9,349 rows across 5 NDJSON files, every line count checked against a separate database count. A real password had reached a git-tracked `.env.example` and was remediated. D-095..D-097 | 1,396 |
| 10 Aug 2026 | **Corpus import.** Migration `0001_pedagogy`; 137 chapters, 4,686 chunks, 2,741 questions, 639 concepts, 176 edges, 57 patterns, 773 held out. Idempotency proven by digest comparison across two full runs. **Four of five `Source*` shapes were wrong, three silently** - all 639 concepts and 57 patterns would have imported as zero. D-098..D-109 | 1,453 |
| 10 Aug 2026 | **Initial commit** `0545689` - 441 files. Repository had survived two near-losses of `PROGRESS.md` with zero commits | 1,453 |
| 10 Aug 2026 | **`practice` — the session engine.** Migration `0002_practice` (3 tables + D-057's rename of `question_responses` to `practice_responses`, forward/rollback/re-apply proven); 28 module files; 10 pure domain modules at 100% coverage; `platform/tx`'s opaque `TransactionToken`, which lets one transaction span `practice` and `learner` without letting either service run a statement (D-056 executed at last). Held-out questions unreachable by construction; every persisted index canonical, proved with a shuffle that moves things; a partial-failure test that injects at the cross-module seam and asserts nothing lands. **Two findings only a real submission surfaced** — an honest perfect score can trip the all-same-index rule, and a reordering shuffle can still leave position 0 in place, so both tests were measuring less than they claimed (D-121). D-110..D-121 | 1,684 |
| 10 Aug 2026 | **`practice` session engine** - six of nine client steps: mission with a stated reason, concept explanation, guided practice, mastery check, evidence-based decision, spaced retention. Migration `0002_practice`. Canonical option indexes, per-chapter held-out reserve honoured, one-transaction submission via an opaque `TransactionToken` (D-056 was unimplementable as written). Three defects caught by tests: an honest perfect score tripped anti-cheat; drizzle-kit silently kept a renamed PK; the canonical-index test was measuring nothing. D-110..D-121 | 1,684 |
| 10 Aug 2026 | **`parent` + `retrieval` wired, and three test-suite defects closed.** Both modules were BUILT and NEITHER was constructed — `parent` half-wired (import landed, construction missing), `retrieval` not at all. Both now in `Modules`, which is total; `retrieval` deliberately registers no routes (D-122). `platform/embed` reached the container: Voyage when keyed, deterministic fake otherwise, and a BOOT FAILURE in production without a key, because the degraded mode has no symptom (D-123). **`parent` service + route tests written from nothing** — 37 + 15 + 10 across allow, four indistinguishable denies, immediate revocation, digest idempotence, quiet-week grace, audit PII. **Two real defects found:** `db.execute()` hands back timestamp WIRE STRINGS, so `DigestRecord.generatedAt` was a string typed `Date` (D-124); and `authoriseSelf` was an unenforced guard — mutating it left the whole suite green (D-125). The three failing migration tests were fixed at the CLASS level: no peeling, properties over the discovered set, two fiction-asserting tests DELETED with reasons, one generic round-trip test in their place, and the D-075 lint rule strengthened to count migration names rather than only array literals (D-126). D-122..D-126 | 1,970 |

---

| 10 Aug 2026 | **`foxy` — the core capability.** Migration `0005_foxy` (`chat_sessions`, `chat_messages`, `retrieval_traces`, forward/rollback proven); 15 module files; 8 domain modules at 100% coverage; five endpoints, one of them SSE. **Guided interface, not open chat** — 3 modes × 6 fixed actions, both TOTAL `Record`s so a new value cannot reach the prompt assembler without a label, an instruction, a budget and a translation (D-163). **Abstention never calls the model** and arrives as a successful 200 with its own frame, its own stored message and its own trace (D-165). **Citations are verified INCREMENTALLY**, so a fabricated marker is stripped before the student sees it rather than after (D-164). Safety classifier before the model, with a real helpline in the harm case and a ten-case false-positive table (D-166). `platform/llm` completed: scripted fake + real adapter, fully tested against a mocked HTTP layer, never called, boot-checked in production (D-170). **A real ordering bug found by the fixed clock** — a question and its reply share a millisecond, so `created_at` cannot order a transcript; `seq bigserial` now does (D-168). **Three authorisation mutations installed and all three observable** — no unenforced guard this time (D-172). D-163..D-172 | 2,491 |
| 10 Aug 2026 | **Deployment, CI/CD, backups and alerting.** `docker/compose.prod.yml` (9 services, resource limits on every one, an `internal: true` data network with no published ports, volume names that cannot collide with the corpus); three multi-stage non-root Dockerfiles; Caddy for three hostnames with a **dedicated SSE policy** — buffering off, 300s upstream read — because getting it wrong breaks Foxy while looking like a model problem. Path-scoped per-app workflows plus a real `ci-gate` fan-in; a self-testing secret scanner closing D-096; migrations as an explicit step that CHECKS THE CATALOGUE (D-109). Continuous WAL archiving + nightly base backup to a SECOND volume, with a restore drill that was RUN and a self-test proving the drill can FAIL. An alert evaluator that finally READS `metrics_events`. **Eight gates each proven to fail on a deliberate violation**, and two of the proofs found defects in the gates themselves. D-140..D-149, D-160..D-162 | 1,993 |
| 10-11 Aug 2026 | **Mutation audit and remediation.** Eleven agents broke every guard, threshold and validation in the codebase. **2,510 passing tests had not noticed 23 defects** - retrieval abstaining on 44% of answerable questions, Foxy's system prompt deletable with 170/170 green, anti-cheat rule 2 firing on 0.105% of its target, a session token in plaintext logs, four guards comparing a value with itself, and a coverage report calling a grade orderable while it produced zero paths. All fixed, three of them structurally rather than by adding assertions. D-178..D-216 | 2,654 |
| 11 Aug 2026 | **Second audit wave - 40+ findings, six agents.** Two production blockers: Compose passed no Razorpay credentials while the container throws without them (both processes restart-loop), and there was **no real mail adapter at all**, so signup and password reset were dead in production behind green probes. Signup also returned 500 on a mail outage *after* committing the user. Three concurrency races fixed - mastery lost update, XP cap, unfenced job leases. `trustProxy: true` collapsed every IP-keyed rate limit. Sessions had no absolute lifetime. `/health/ready` accepted a half-migrated database and leaked host/port/user. Metrics sat in memory for 100 observations. A paying customer got the free tier. **Caught in the act: drizzle-kit generated migration `0006` with a timestamp 370M ms BELOW its predecessor** - D-174 recurring, caught by the test written for it. D-217..D-280 | 2,926 |
| 11 Aug 2026 | **Third audit and remediation, plus a clean database.** Six auditors asked questions the first two waves structurally could not: a real end-to-end journey, a systematic sweep for tests that pass for the wrong reason, cross-module seams, the worker and the degradation matrix, comments claiming guarantees, and the frontend. **The worst defect in the project was found: a student could answer every question wrong, read the revealed indices back from the API, re-answer, and score 100% with `isValid: true`** - while the evidence table recorded a flawless first-time attempt. Also: every XP payout and the Foxy cap could be changed with 2,530 tests green; every production alert could be silently disabled with 23/23 green; module-to-pool wiring was asserted nowhere; worker shutdown hung on the common deploy path; and a dependency that failed *fast* was invisible to every alert rule. All fixed. D-281..D-334 | 3,166 |

| 12 Aug 2026 | **Frontend step 0 — the foundation, and the first real network call.** Backend contracts generated into `frontend/src/lib/api/generated/` with a drift test (a direct import cannot exist: the frontend image copies `frontend/` alone). §5.6's error table enforced by an exhaustive switch over the generated union — **a 403 on a POST is a blocked action, never a logout**. One typed client, `credentials: 'include'`, responses validated against the Zod contract. Session context with a three-valued status: `loading` renders a skeleton and never redirects, any 401 clears the query cache. `useFoxyStream` + the SSE parser, **all seven cases in plan §7 tested**, frames reassembled across chunk boundaries. Token scales CLOSED rather than extended, with a lint rule that caught five existing breakages the moment it ran. **Two plan errors found: `GET /me/profile` cannot be the session bootstrap (a parent gets 403, an un-onboarded student 404, and neither carries the role) — `GET /api/v1/auth/me` added to `identity`; and the `proxy.ts` cookie presence check is impossible, because the session cookie is host-bound to the API and the app server never sees it.** Item 33 narrowed: `--webpack` fails identically, so the bundler is ruled out | 3,173 backend · 57 frontend |

| 12 Aug 2026 | **The frontend CI gates — §10.7 closed.** Coverage floors enforced PER AREA rather than as one global number; bundle budgets (180 kB route / 120 kB shared, gzipped) with ten unit tests over a synthetic build; a deployable-isolation check that walks the tree rather than trusting the lint config; visual regression across two journeys x two breakpoints x two themes; contrast asserted in BOTH themes, with a companion test proving the themes really differ; Lighthouse LCP/TBT wired for CI. **Six gates were deliberately broken and observed to fail.** The gates then found two defects in this session's own work: an INFINITE 401 LOOP in the session provider (`queryClient.clear()` removes the bootstrap query, whose observer refetches — thirty-odd requests and a login page that never painted), and eleven layout utilities rendering with no size because the closed token scale makes Tailwind emit nothing. D-339..D-341 | 3,173 backend · 146 + 24 frontend |

| 12 Aug 2026 | **`components/ui` and `components/patterns` — build-order steps 1-4.** Six primitives (Button with three variants, Input/Textarea/Select, Card, Badge, Skeleton, Dialog) and nine patterns (LoadingState, EmptyState, ErrorState, PageHeader, StatCard, EvidenceLabel, FormField, ConfirmDialog, OfflineBanner), 92 tests, every variant. **The Dialog is hand-written rather than native `<dialog>`** — jsdom has no `showModal`, so a native modal's focus trap could only be tested against a polyfill, and the trap IS the component. Two client constraints are now structural: `EvidenceLabel` has no `value` prop, so a mastery percentage cannot be rendered through it; nothing shared renders a failure in red. **The suite caught a defect in this session's own code** — a rejected `onConfirm` escaped `ConfirmDialog` as an unhandled promise rejection, a console error in the user's browser under a dialog that re-enabled with no explanation. D-342..D-343 | 3,173 backend · 216 + 24 frontend |

| 12 Aug 2026 | **Internationalisation — build-order step 5.** Both dictionaries (English is the SHAPE, `hi: Dictionary` makes a missing key a compile error), a dotted-path `TranslationKey` union so a typo fails the build, server and client translators sharing one implementation, the language switch, and Noto Sans Devanagari subset to `devanagari` with `preload: false` — so an English reader never downloads it. Every user-facing string migrated out of JSX; the `no-literal-jsx-text` rule now covers text nodes AND `aria-label`/`alt`/`placeholder`/`title`, proven by probe. **The visual-regression language axis is live**, plus a Hindi horizontal-overflow check — §10.7's four axes are finally all real. Closes open item 34: the onboarding form submitted `english`/`hindi` against a contract accepting `en`/`hi`, and offered grades 6-10 against a syllabus and a CHECK that run to 12; both now come from the generated constants. **A framework trap found and fixed: `LANGUAGE_COOKIE` was exported from a `'use client'` module, so the server's `cookies().get()` looked up a client reference, found nothing, and rendered `<html lang="en">` with Hindi content underneath** | 3,173 backend · 236 + 28 frontend |

## 12. Update protocol

At the end of every session, before stopping:

1. Update **section 1** — module count, test count, remaining estimate.
2. Move completed items from *Remaining* into **section 3**, with the date.
3. Rewrite **section 2** — there is always exactly one next action.
4. Add any new blocker or gap to **section 7**.
5. Append a row to **section 11**.
6. Append every non-obvious decision to `docs/03-DECISION-LOG.md`, and patch the plan document if the decision contradicts it.

**Never write a test count or a module count from memory.** Run the command:

```bash
cd backend && npm test          # test count
ls -d backend/src/modules/*/    # modules built
```

The previous codebase drifted because numbers were hand-maintained in prose. Measure, then write.
