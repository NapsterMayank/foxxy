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
| Corpus | **IMPORTED.** 137 chapters · 4,686 chunks · 2,741 questions · 639 concepts · 176 edges · 57 misconception patterns |
| Architecture | Modular backend + isolated product frontend + marketing/CMS deployable |
| Team | 1 engineer |
| Backend modules | **7 of 11 built** (identity, learner, content, notify, practice, **parent**, **retrieval**). Both new ones are now CONSTRUCTED in `app/routes.ts` — `parent` registers six endpoints, `retrieval` registers none by design (D-122) |
| Backend processes | **2** — `api` and `worker`. The worker exists and runs one real job |
| Frontend | **scaffolded** - 81 source files under `frontend/src`, committed. Build-order step 0 (the five foundation gaps) not yet closed |
| Marketing site | **scaffolded** - 32 files under `website/`, committed. Per `06-FRONTEND-SEPARATION-PLAN.md` |
| Tests | **1,970 passing**, 109 files |
| Migrations | `0000_baseline` + `0001_pedagogy` + `0002_practice` + `0003_parent`. Every one of them now has a rollback test, because the round-trip is asserted over the DISCOVERED set rather than per file (D-126) |
| Gates | type-check · lint · build · test · coverage — all green. `platform/authz` 100%, `parent/domain` 100%, `parent.service` 94.0%, `retrieval` 99.1%, `practice/domain` 100% |
| Estimated remaining | **~92 days ≈ 19 weeks solo** |
| Git | **4 commits**, latest `45241c7`. Working tree has the `parent` + `retrieval` wiring STAGED, uncommitted. No remote configured |

---

## 2. THE NEXT ACTION

> **Build `foxy` (build step 10).** `retrieval` is complete and wired, `parent`
> is complete and wired, and the `embed` adapter now exists — so `foxy` is the
> only remaining module on the critical path to the product's core capability.

Two things that are now unblocked and were not before:

1. **Threshold calibration by measurement, never by guess.** The harness exists
   (`eval/retrieval/calibrate.ts`, `npm run eval:retrieval:calibrate`) and is
   blocked ONLY on `VOYAGE_API_KEY`. Until it runs, `ABSTAIN_THRESHOLD` ships
   marked `UNCALIBRATED` in its own type and set to the minimum achievable fused
   score, so it is INERT — it filters nothing rather than filtering everything,
   which is the failure the previous system had for a year. A test asserts both
   the marking and the inertness. **Calibrate against ~3,487 DISTINCT chunks, not
   4,686** — see D-108.
2. **Re-embed the 20 NULL-embedding chunks** (D-078). In the database, reachable
   by full-text search, invisible to vector search. Ids in
   `.corpus-extract/reports/chunks-without-embedding.txt`.

`npm run eval:retrieval:sparse` needs no key at all and measures the sparse half
against the real corpus today. Both scripts are read-only and both are now
declared in `package.json` — they were documented in the harness headers and
missing from the manifest, so the commands the comments told you to run did not
exist.

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
| 🟡 7 | `embed` **real adapter DONE** (Voyage, guarded, boot-checked — D-123); `llm` adapter still an interface | 1 | `VOYAGE_API_KEY` for calibration; LLM key for `foxy` |
| ✅ 8 | **`retrieval`** — module built, wired on the `ai` pool, no HTTP surface by design. Threshold ships `UNCALIBRATED` and INERT; the calibration harness is written | 0.5 | calibration blocked on `VOYAGE_API_KEY` only |
| ✅ 9 | `learner` | — | — |
| ⬜ 10 | `foxy` | 10 | LLM key — **now the critical path** |
| ✅ 11 | **`practice`** — module, migration `0002`, 231 tests, atomic submission across two modules | — | — |
| ✅ 12 | **`parent`** — module, migration `0003_parent`, six endpoints, the weekly digest seam filled into `notify`. Transcript reads return `not_yet_available` until `foxy` lands | — | — |
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

Build order from `docs/02-FRONTEND-IMPLEMENTATION-PLAN.md` section 11. **Nothing started.**

| Step | Item | Days |
|---|---|---|
| ⬜ 1-4 | Tooling · design tokens · `ui` primitives · `patterns` · `AppShell` | 8 |
| ⬜ 5-6 | i18n scaffold and both dictionaries · API client · providers | 4 |
| ⬜ 7-8 | `auth` · `onboarding` | 6 |
| ⬜ 9 | **`foxy`** — streaming, citations, all 7 edge cases in plan section 7 | 8 |
| ⬜ 10-11 | `practice` · `progress` | 8 |
| ⬜ 12 | `parent-dashboard` | 6 |
| ⬜ 13 | `billing` | 3 |
| ⬜ 14-15 | Responsive pass on a real device · accessibility · 2 E2E specs | 7 |
| | **Subtotal** | **~50** |

**Steps 1-4 look slow and are not.** Building primitives and patterns before any screen is what makes every screen afterwards fast and consistent. Skipping them means the fifth screen costs more than the first.

---

## 6. Pedagogy scope — agreed, not started

Nine capabilities were assessed. Full build is ~50 days; this subset is **20 days** and closes every one-way door.

| Capability | Scope agreed | Days |
|---|---|---|
| Constrained Foxy | already the design — grounding, abstention, citation verification | 0 |
| **Misconception detection** | minimal: distractor-to-misconception codes, weekly aggregation | 6 |
| **Spaced-retention scheduler** | full — FSRS or SM-2, pure functions on the injected clock | 4 |
| Anomaly rules | basic — reuse anti-cheat, add inactivity and mastery drop | 1.5 |
| Rules engine | foundation only — versioned evaluator, rule version stamped on every decision | 2 |
| Prerequisite concept graph | foundation only — schema plus hand-seeded chapter-level prerequisites | 3 |
| Adaptive difficulty | seed — ladder on authored difficulty, plus full response logging | 2 |
| Explainable priority scoring | seed — two candidate types, with real reason strings | 1.5 |
| Independent mastery checks | held-out question pool reserved | 0.5 |

Deferred until real usage data exists: full IRT calibration, concept-level graph extraction, multi-factor priority weights, scheduled mastery checks.

---

## 7. Open items and known gaps

### Agreed, not implemented
| # | Item | Source | Effort |
|---|---|---|---|
| 3 | Leetspeak normalisation cannot see a substitution in the first character (`8utterfly` is accepted). Documented and asserted, not hidden | D-018 follow-up | — |
| 4 | `questions` cannot enforce "all four options are DISTINCT" — a CHECK may not contain a subquery, and distinctness needs aggregation. It is a `content` module rule. The module now EXISTS, so it finally has somewhere to live: apply it on the write path when one is built, or as an import validation | D-039 | 30 min |
| 8 | **`audit_log` and `notifications` keep NULLABLE tenants, deliberately.** Neither is student-owned data reached through `assertCanAccess`, and — the deciding point — neither has a writer that knows a tenant: `audit_log` records system actions whose actor is null by design, and the in-app channel is handed a recipient and nothing else. A NOT NULL column whose only writer relies on the column default is theatre of exactly the kind D-073 rejects. **The mechanism when it is done:** resolve the tenant from the recipient / the actor as a scalar sub-select in the INSERT, and leave `audit_log` nullable for genuinely actor-less rows | D-084 | 2 h |
| 9 | **Moving an account between tenants MUST revoke its sessions.** A student reaching their own data short-circuits the tenant lookup and trusts the session's tenant — safe today (the data moves with them, and a parent gets no short-circuit) but it makes session revocation a hard requirement of any account-moving code, the same way a password reset revokes sessions. Nothing moves accounts between tenants yet | D-083 | 1 h, with the feature |
| 11 | **1,199 of 4,686 imported chunks are exact text duplicates** — the same NCERT passages ingested twice under two `chapter_title` conventions. The effective distinct corpus is **~3,487 chunks**, and duplicates compete for the same top-k slots (the manual vector query returned one passage twice in its top six). NOT deduplicated by the import, deliberately: which copy is canonical is a retrieval-quality decision that belongs with threshold calibration, where it can be measured | D-108 | 1 day, with step 8 |
| 12 | **20 chunks carry a NULL embedding and are invisible to vector search.** Ids in `.corpus-extract/reports/chunks-without-embedding.txt`. They import with NULL and are reachable by full-text search; **no vector was fabricated.** Needs `VOYAGE_API_KEY` and the `embed` adapter | D-078 | 1 h, with step 7 |
| 13 | **The question-level pedagogy layer is confirmed empty in the imported data** — `hint_level_1`, `hint_level_2`, `hint_level_3` and `solution_steps` are NULL on all 3,791 source questions, and `question_hi` on 3,581 of them. `distractor_misconceptions` is NULL on all 2,741 imported questions: the 57 misconception patterns exist but nothing links a pattern to a distractor. Generation, scoped to the pilot chapters, is unavoidable | D-077 | section 6 |
| 14 | **`misconception_patterns` has no Hindi description, and the source has no such column** — not "usually null", it does not exist. A P7 gap that needs translations written, not a column added | D-098 | with the pedagogy subset |
| 15 | **The dev database's drizzle ledger predates the baseline collapse**, so `db:migrate` skipped `0001` on timestamp order while reporting success. Worked around by setting 0001's journal `when` above the last applied row. Any other database created from the 0000-0008 chain has the same hazard | D-109 | 30 min, if another such database exists |
| 16 | **The development database is still on `0001` — `0002_practice` has NOT been applied to it.** Deliberate: applying it needed a `db:migrate` against the database holding the imported corpus, and D-109's hazard (a "Migrations applied." that applies nothing, because the ledger predates the baseline collapse) makes that a step to take deliberately rather than incidentally. Nothing is at risk — `0002` adds three tables and renames an EMPTY one, and its own `DO` block refuses to run if that table has rows. The whole test suite runs against testcontainers and is unaffected. **Check the catalogue, not the exit code**: after `npm run db:migrate`, `select 1 from information_schema.tables where table_name = 'practice_responses'` | D-109, D-110 | 15 min |
| 10 | **Per-migration drizzle snapshots for `0004`-`0007` do not exist and cannot be reconstructed** — those schema states were never committed. The chain is LINKED (`0008.prevId` = `0003.id`) and `db:generate` emits nothing, which is the property that matters; `drizzle-kit check` passes and is exposed as `npm run db:check`. The alternative that would give a gapless chain is to collapse `0000`-`0008` into one baseline migration plus one snapshot — **a user decision, since it rewrites already-applied migrations** | D-081 | 2 h, if chosen |

**Closed on 10 August:** item 1 (CORS read/write split — D-082), item 2
(`POST /links/code` rate limit — D-085), item 5 (global authenticated rate limit
— D-080), item 6 (drizzle snapshot chain — D-081, with the residue above as item
10), item 7 (`tenant_id` NOT NULL and the strict guard — D-073).

**Closed on 9 August:** the `distractor_misconceptions` shape (jsonb object keyed
by option index, migration `0003`, D-048) and `hnsw.ef_search` (set to 100 on the
`ai` pool from config, D-049).

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
