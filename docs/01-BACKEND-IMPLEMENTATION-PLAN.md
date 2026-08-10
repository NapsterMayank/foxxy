# Backend Implementation Plan

Written to be followed step by step. If a decision has a trap in it, the trap is called out.

**Prerequisite:** read `00-ARCHITECTURE.md` first. This document assumes the four foundations and the module map defined there.

---

## 1. Stack

| Concern | Choice | Package |
|---|---|---|
| Runtime | Node.js 22 LTS | — |
| Language | TypeScript, `strict: true` | `typescript` |
| HTTP server | Fastify | `fastify` |
| Validation | Zod, on every boundary | `zod`, `fastify-type-provider-zod` |
| ORM | Drizzle | `drizzle-orm`, `drizzle-kit` |
| Database | PostgreSQL 16 + `pgvector` — **published on port 5433 locally**, see **D-009** | `pg` |
| Password hashing | Argon2id | `@node-rs/argon2` |
| Sessions | Opaque tokens in Postgres | — |
| Cache & rate limit | Valkey | `ioredis` |
| Testing | Vitest | `vitest` |
| Integration test DB | Real Postgres in a container | `testcontainers` |
| HTTP mocking | Interceptor, not hand-rolled mocks | `msw` |
| Logging | Structured JSON | `pino` |
| Embeddings | Voyage `voyage-3` (client-approved; matches the corpus) | `voyageai` |
| Email | Resend (client-approved) | `resend` |
| Payments | Razorpay (regulated, no alternative) | `razorpay` |

Three development dependencies not listed above are load-bearing and were added during implementation: `tsx`, `tsc-alias` and `vite-tsconfig-paths`. See decision **D-007**.

**Two rules about dependencies.** Every package added must be justified in the pull request. Anything a vendor SDK touches goes behind a port in `platform/` — never imported directly by a module.

---

## 2. Folder structure

```
backend/
├─ src/
│  ├─ app/                      composition root — wires everything together
│  │  ├─ server.ts              creates the Fastify instance
│  │  ├─ routes.ts              registers every module's routes
│  │  ├─ container.ts           builds and injects dependencies
│  │  └─ plugins/               auth, error handler, request id, rate limit, cors
│  │
│  ├─ modules/                  ALL business logic
│  │  ├─ identity/
│  │  ├─ learner/
│  │  ├─ content/
│  │  ├─ retrieval/
│  │  ├─ foxy/
│  │  ├─ practice/
│  │  ├─ parent/
│  │  ├─ billing/
│  │  └─ notify/
│  │
│  ├─ platform/                 infrastructure. NO business rules.
│  │  ├─ db/                    Drizzle client, schema, transaction helper
│  │  ├─ config/                typed, validated environment variables
│  │  ├─ logger/                pino instance with PII redaction
│  │  ├─ authz/                 the single access boundary
│  │  ├─ llm/                   LLMProvider interface + adapters
│  │  ├─ embed/                 EmbeddingProvider interface + adapters
│  │  ├─ cache/                 CachePort interface + Valkey adapter
│  │  ├─ events/                in-process event bus + outbox
│  │  ├─ errors/                the application error hierarchy
│  │  └─ http/                  outbound HTTP client with retry and timeout
│  │
│  └─ shared/                   imported by BOTH backend and frontend
│     ├─ contracts/             Zod request/response schemas per module
│     └─ constants/             enums, XP values, limits
│
├─ tests/
│  ├─ integration/              real database, real HTTP, fake external APIs
│  ├─ fixtures/                 factory functions that build test data
│  └─ helpers/                  test database setup, auth helpers
│
├─ drizzle/migrations/          generated SQL migrations. NEVER edit a merged one.
├─ scripts/                     corpus migration, seeding, one-off tasks
└─ docker/                      compose file for Postgres and Valkey
```

### Anatomy of a module

Every module has the same shape. No exceptions — predictability is the point.

```
modules/practice/
├─ index.ts                     PUBLIC. The only file other modules may import.
├─ practice.routes.ts           HTTP: parse, validate, call service, format response
├─ practice.service.ts          use-cases. orchestrates domain + repository + events
├─ practice.repository.ts       ALL database access for this module
├─ practice.schema.ts           Zod schemas for this module's inputs and outputs
├─ practice.types.ts            internal types
├─ domain/
│  ├─ scoring.ts                pure functions. no database, no network, no clock
│  ├─ xp-rules.ts               pure. all XP constants live here and nowhere else
│  └─ anti-cheat.ts             pure
└─ __tests__/
   ├─ scoring.test.ts
   ├─ xp-rules.test.ts
   ├─ anti-cheat.test.ts
   ├─ practice.service.test.ts
   └─ practice.routes.test.ts
```

**Responsibility of each layer — memorise this, it prevents most design mistakes:**

| Layer | Does | Must never |
|---|---|---|
| `routes` | Validate input, call one service method, map the result to HTTP | Contain an `if` about business rules, or touch the database |
| `service` | Orchestrate: load data, call domain functions, persist, emit events | Contain a calculation. Calculations belong in `domain/` |
| `repository` | Build and run queries, map rows to types | Contain business rules or call another module |
| `domain` | Pure calculation and decision-making | Perform I/O, read the clock, generate a random number, or read an environment variable |

The `domain` restriction is what makes those tests instant and deterministic. If a domain function needs the current time, **pass it in as an argument.**

---

## 3. Conventions

| Item | Rule | Example |
|---|---|---|
| Files | kebab-case | `practice.service.ts`, `anti-cheat.ts` |
| Types and classes | PascalCase | `PracticeSession` |
| Functions and variables | camelCase | `calculateScore` |
| Constants | SCREAMING_SNAKE_CASE | `XP_PER_CORRECT` |
| Database tables | snake_case, plural | `practice_sessions` |
| Database columns | snake_case | `score_percent` |
| Booleans | `is` / `has` / `can` prefix | `isActive`, `canAccess` |
| Async functions | verb first | `getStudentById`, `createSession` |
| Endpoints | plural nouns, kebab-case | `/api/v1/practice-sessions` |

**Hard rules:**
- `strict: true`. `any` is banned; use `unknown` and narrow it.
- Every exported function has an explicit return type.
- No default exports. Named exports only — they refactor and autocomplete correctly.
- Every function that can fail returns a typed error or throws a typed `AppError`. Never a bare string.
- **Grades are strings** `"6"` to `"12"`. Never numbers, anywhere: database, API, TypeScript.
- No magic numbers. Name it, put it in `domain/` or `shared/constants/`.

---

## 4. Database schema

All tables in one Postgres database. Defined in `platform/db/schema/`, one file per module, re-exported from `schema/index.ts`.

### identity

| Table | Key columns | Notes |
|---|---|---|
| `users` | `id` uuid PK · `email` citext UNIQUE · `password_hash` text · `role` text CHECK in (student, parent) · `email_verified_at` · `created_at` | One row per human. Role is fixed at signup |
| `sessions` | `id` uuid PK · `user_id` FK · `token_hash` text UNIQUE · `expires_at` · `created_at` · `last_used_at` · `user_agent` · `ip_hash` | Opaque token sessions. Store the HASH, never the token |
| `email_verification_tokens` | `id` · `user_id` FK · `token_hash` UNIQUE · `expires_at` · `consumed_at` | Single use |
| `password_reset_tokens` | same shape as above | Single use |
| `link_codes` | `id` · `student_user_id` FK · `code` UNIQUE · `expires_at` · `consumed_at` | A code is issued **before** any parent is known, so it cannot live on the link row. One active code per student, enforced by a partial unique index on `student_user_id WHERE consumed_at IS NULL`. See **D-012** |
| `parent_child_links` | `id` · `parent_user_id` FK · `student_user_id` FK · `status` CHECK in (pending, approved, revoked) · `link_code` · `approved_at` · `revoked_at` | UNIQUE on (parent_user_id, student_user_id) |

### learner

| Table | Key columns |
|---|---|
| `students` | `user_id` PK FK · `display_name` · `grade` **text** CHECK in ('6'..'12') · `board` · `preferred_language` CHECK in (en, hi) · `created_at` |
| `student_subjects` | `student_user_id` FK · `subject_code` · PK on both |
| `chapter_mastery` | `student_user_id` · `chapter_id` FK · `mastery_score` numeric · `attempts` int · `last_practised_at` · PK on (student, chapter) |

### content

| Table | Key columns |
|---|---|
| `chapters` | `id` uuid PK · `grade` text · `subject_code` · `chapter_number` int · `title_en` · `title_hi` · UNIQUE on (grade, subject_code, chapter_number) |
| `questions` | `id` · `chapter_id` FK · `question_text` · `options` jsonb (exactly 4) · `correct_index` int CHECK 0..3 · `explanation` · `difficulty` · `bloom_level` · `is_active` |
| `rag_chunks` | `id` · `chapter_id` FK nullable · `grade` text · `subject` · `chapter_number` · `chunk_text` · `embedding` **vector(1024)** · `search_vector` tsvector · `quality_score` · `is_active` |

`rag_chunks` is populated by the corpus migration, not by hand. Indexes: HNSW on `embedding`, GIN on `search_vector`, btree on `(grade, subject)`.

### foxy

| Table | Key columns |
|---|---|
| `chat_sessions` | `id` · `student_user_id` FK · `mode` CHECK in (doubt, explain, practice) · `chapter_id` nullable · `started_at` · `last_message_at` |
| `chat_messages` | `id` · `session_id` FK · `role` CHECK in (user, assistant) · `content` · `citations` jsonb · `abstained` boolean · `created_at` |
| `retrieval_traces` | `id` · `message_id` FK · `rewritten_query` · `retrieved` jsonb (chunk ids + scores) · `model` · `input_tokens` · `output_tokens` · `latency_ms` · `created_at` |

`retrieval_traces` is the only way you will ever debug a bad answer. Write it from the first day.

### practice

| Table | Key columns |
|---|---|
| `practice_sessions` | `id` · `student_user_id` FK · `chapter_id` FK · `question_ids` uuid[] · `started_at` · `submitted_at` · `score_percent` int · `xp_earned` int · `is_valid` boolean · `invalid_reason` |
| `practice_responses` | `id` · `session_id` FK · `question_id` FK · `selected_index` int · `is_correct` boolean · `time_spent_ms` int |
| `xp_ledger` | `id` · `student_user_id` FK · `source` · `source_id` · `amount` int · `created_at` |

`xp_ledger` is append-only. A student's total XP is a SUM over it, never a mutable counter column. Counters drift; ledgers do not.

### parent, billing, notify

| Table | Key columns |
|---|---|
| `weekly_digests` | `id` · `parent_user_id` · `student_user_id` · `week_start` date · `summary_en` · `summary_hi` · `misconception` · `suggested_action` · `generated_at` · UNIQUE on (parent, student, week_start) |
| `subscriptions` | `id` · `user_id` FK · `plan_code` · `status` · `provider_subscription_id` · `current_period_end` |
| `payment_events` | `id` · `provider_event_id` **UNIQUE** · `payload` jsonb · `processed_at` |
| `notifications` | `id` · `user_id` FK · `kind` · `title_en` · `title_hi` · `body_en` · `body_hi` · `read_at` · `created_at` |

`payment_events.provider_event_id` being UNIQUE is what makes webhook processing idempotent. Payment providers retry. They will send the same event twice.

### Migration rules

1. Migrations are generated by `drizzle-kit`, then reviewed by hand before committing.
2. **Never edit a migration that has been merged.** Write a new one.
3. Never drop a column in the same release that stops using it. Stop reading it, ship, then drop in a later release.
4. Every migration must run forward and backward against a copy of the schema in CI.

---

## 5. Platform layer — the ports

Each is an interface, plus at least one real adapter, plus a fake for tests. Build the fake at the same time as the interface, not later.

| Port | Interface | Real adapter | Test fake |
|---|---|---|---|
| `db` | Drizzle client + `withTransaction(fn)` | Postgres | Real Postgres in a container. **Never fake the database** |
| `llm` | `stream(req): AsyncIterable<Chunk>` · `complete(req)` | Hosted API (client-approved; swappable by config) | Returns a scripted response |
| `embed` | `embedQuery(text): Promise<number[]>` | **Voyage** `voyage-3`, 1024 dims (matches the existing corpus). Fallback adapter: self-hosted BGE-M3 | Returns a deterministic vector |
| `cache` | `get` `set` `del` `incr` `expire` | Valkey | In-memory Map |
| `mail` | `send(to, template, data)` | Resend | Records calls to an array |
| `payments` | `createSubscription` · `verifyWebhook` | Razorpay | Returns fixed objects |
| `clock` | `now(): Date` | `new Date()` | Returns a fixed date |
| `idGen` | `uuid(): string` | `crypto.randomUUID` | Returns a counter |

**`clock` and `idGen` look like over-engineering. They are not.** Without them you cannot write a deterministic test for session expiry, token lifetime, digest week boundaries, or anything ordered by id. Two tiny files that remove an entire category of flaky test.

### `platform/config`

One file. Reads `process.env` once, validates with Zod, exports a frozen typed object. **The server refuses to start if a required variable is missing** — fail at boot, not at 2am on the one code path that reads it. No `process.env` access anywhere else, enforced by an ESLint rule.

### `platform/errors`

```
AppError  (code, httpStatus, message, safeMessage)
  ValidationError       400
  UnauthenticatedError  401
  ForbiddenError        403
  NotFoundError         404
  ConflictError         409
  RateLimitError        429
  DependencyError       502    an external system failed
  InternalError         500
```

`message` goes to logs. `safeMessage` goes to the client. One Fastify error handler maps `AppError` to a response and converts anything unrecognised into a generic 500. **Never leak an internal message or a stack trace to a client.**

### `platform/logger`

Pino, JSON output, one child logger per request carrying the request id. Redaction configured once at construction for: `password`, `token`, `email`, `phone`, `authorization`, `cookie`, `otp`, `apiKey`. Central configuration, not something each call site must remember.

---

## 6. Authentication — full specification

Deliberately exhaustive. Authentication is where a small mistake becomes an incident, and it is the part most often written from half-remembered examples.

### 6.1 Model

**Opaque session tokens stored in Postgres. Not JWTs.**

A JWT cannot be revoked before it expires. For a product used by minors — where a parent may revoke access or a device may be lost — instant revocation matters more than saving one indexed, sub-millisecond database read.

| Item | Value | Reason |
|---|---|---|
| Token | 32 random bytes, base64url | 256 bits from `crypto.randomBytes` |
| Stored as | SHA-256 hash of the token | A database leak must not yield usable sessions |
| Transport | `httpOnly` `secure` `sameSite=lax` cookie | JavaScript cannot read it, so an XSS bug cannot steal it |
| Lifetime | 30 days absolute | |
| Renewal | Extend when used and older than 24 hours | Active users are never logged out |
| Password hash | Argon2id — memory 19 MiB, iterations 2, parallelism 1 | OWASP 2024 baseline |

### 6.2 Signup

`POST /api/v1/auth/signup` — `email`, `password`, `role` (student or parent)

1. Validate with Zod. Password minimum 10 characters. **No character-class rules** — length beats complexity, and complexity rules push users toward `Passw0rd!`.
2. Reject the 10,000 most common passwords, with a clear message.
3. Normalise the email: trim and lowercase. The column is `citext`.
4. Hash with Argon2id.
5. Insert. **Race condition:** two simultaneous signups with the same email both pass an existence check. The UNIQUE constraint is the real protection — catch the violation and return 409. Do not rely on the check alone.
6. Create a verification token: 32 random bytes, store the hash, expire in 24 hours.
7. Send the email through the `mail` port.
8. **Return 201 with no session.** Not logged in until verified.

**The enumeration trap.** If signup replies "email already registered", anyone can discover which addresses have accounts. On a platform used by children that is a genuine privacy problem. Return the identical 201 either way, and email the existing account "someone tried to sign up with your address" instead. Same user experience, leak closed.

### 6.3 Email verification

`GET /api/v1/auth/verify?token=...`

Hash the token, look it up, confirm unconsumed and unexpired, set `email_verified_at`, mark consumed, create a session, redirect to onboarding. Tokens are **single use** — consume it in the same transaction that sets `email_verified_at`.

### 6.4 Login

`POST /api/v1/auth/login` — `email`, `password`

1. Rate limit **before touching the database**: 5 attempts per 15 minutes, keyed by IP **and** by email. Both — an attacker rotating IPs against one account must also be stopped.
2. Look up by normalised email.
3. **If no user exists, still run a dummy Argon2 verification against a fixed hash.** Otherwise response time reveals whether the account exists. This side channel is trivially measurable.
4. Verify the password.
5. If the email is unverified, return 403 with a machine-readable code (`EMAIL_NOT_VERIFIED`) so the frontend can offer to resend.
6. Generate the token, store its hash, set the cookie.
7. Return the user profile. **Never put the token in the response body** — that defeats `httpOnly` entirely.

Failed login returns exactly one message: *"Invalid email or password."* Never "no such user", never "wrong password".

### 6.5 Session validation

A Fastify plugin, running before every protected route:

1. Read the cookie. Absent → 401.
2. Hash it, look up the session joined to the user.
3. Missing or expired → clear the cookie, return 401.
4. If `last_used_at` is older than 24 hours, extend `expires_at` and update it.
5. Attach `{ userId, role }` to the request. **Never attach the whole user row** — routes will start reading fields off it and you lose control of what gets loaded.

### 6.6 Logout

`POST /auth/logout` deletes the session row and clears the cookie.
`POST /auth/logout-all` deletes every session for the user. Required for "sign out everywhere" after a password change.

### 6.7 Password reset

`POST /auth/forgot-password` — **always return 200**, whether or not the account exists. Same enumeration reasoning. If it exists, create a single-use token valid 1 hour and email it.

`POST /auth/reset-password` — verify the token, hash the new password, update it, **delete every existing session for that user**, consume the token. All in one transaction. If the reset was triggered by a compromise, leaving old sessions alive defeats the whole exercise.

### 6.8 Parent-child linking

The only cross-user data path in the product. Treat it accordingly.

1. Student requests a link code. 6 characters from an unambiguous alphabet — no `0`/`O`, no `1`/`I`/`l`. Expires in 15 minutes. **One active code per student.**
2. Student shares it out of band.
3. Parent submits it. Rate limit 5 per hour per parent account — a 6-character code is brute-forceable without this.
4. Create the link with status `pending`.
5. **The student approves it in the app.** A code alone never grants access.
6. On approval, set `approved` and record the timestamp.
7. Either party may revoke, and revocation is immediate — every parent read checks link status **at query time**, not at login time.

**The trap:** it is tempting to grant access the moment the code is entered. Do not. The approval step is what makes consent real, and it is what you point at when a parent, a school, or a regulator asks how consent is obtained.

### 6.9 Rate limits

| Endpoint | Limit | Keyed by |
|---|---|---|
| signup | 3 / hour | IP |
| login | 5 / 15 min | IP **and** email |
| forgot-password | 3 / hour | IP **and** email |
| verify · reset | 10 / hour | IP |
| link-code submit | 5 / hour | parent user id |
| Foxy messages | per subscription plan | student user id |
| all other authenticated | 100 / min | user id |

Counters live in the cache under an expiring key. **Never in process memory as the primary store** — that stops working the moment you run a second instance, and it fails silently.

**Amended 8 August 2026 (D-034).** There is now one exception, and only one: when the cache is UNAVAILABLE, counting falls back to a per-instance in-memory window for the duration of the outage. The original rule stands for the healthy path — the shared counter is still the real one — but failing closed meant a dead cache returned 500 from every login, so one container took authentication down for the whole product. The fallback is deliberately weaker, and every activation is logged at `warn` and emitted as a metric, because a silent fallback is a silent security downgrade.

### 6.10 Threats and defences

| Threat | Defence |
|---|---|
| Credential stuffing | Rate limit on IP and email; common-password rejection |
| Account enumeration | Identical responses on signup, login and forgot-password |
| Timing side channel | Dummy hash verification when the user does not exist |
| Session theft via XSS | `httpOnly` cookie — the token is never reachable from JavaScript |
| Cross-site request forgery | `sameSite=lax` plus an origin check on state-changing requests. Both built as of 8 August 2026: the check is a shared `onRequest` hook in `src/app/plugins/origin-check.ts` covering POST/PUT/PATCH/DELETE, allowed origins from config, a missing `Origin`/`Referer` rejected, payment webhooks exempt with HMAC verification as the compensating control (D-035) |
| Session fixation | A fresh token on every login; the old one is never reused |
| Database leak yielding live sessions | Only SHA-256 hashes are stored |
| Reset that fails to lock out an attacker | Reset deletes all sessions |
| Link-code brute force | Short expiry, one active code, rate limit, mandatory student approval |

---

## 7. Authorization — one boundary

Authentication answers *who are you*. Authorization answers *may you touch this*. They are separate concerns, and mixing them is how access-control bugs are born.

**One function. One file. `platform/authz/can-access.ts`.**

```
createAccessGuard({ readLinkStatus }).assertCanAccess(actor, action, resource): void
```

Built by a factory so the link-status reader can be injected while the call signature stays exactly three arguments. The reader is synchronous, which forces the caller to load link status immediately before calling — which is what "read at query time" means. See decision **D-001**.

Throws `ForbiddenError` when denied. Every service method that touches data belonging to a specific student calls it. There is no second place where access is decided.

| Actor | Resource | Rule |
|---|---|---|
| student | own profile, sessions, practice, chat | allow |
| student | any other student's anything | **deny** |
| parent | linked child, link status `approved` | allow, read-only |
| parent | linked child, status `pending` or `revoked` | **deny** |
| parent | any unlinked student | **deny** |
| parent | own subscription and profile | allow |
| anyone authenticated | content and chapters | allow |

**Four rules that make this work:**

1. **Deny by default.** The function ends in `throw new ForbiddenError()`. Access is granted only by an explicit branch above that line.
2. **No payload on a deny.** A 403 body says only "forbidden". Never "that student exists but is not linked to you" — that is an enumeration leak wearing a different hat.
3. **Link status is read at query time**, never cached in the session. Revocation must be instant.
4. **No database access outside a repository.** Enforced by an ESLint rule banning `db` imports outside `*.repository.ts`. Without it, someone eventually writes a query that skips the check.

**Coverage on this file is 100%. Not a target — a gate.** Every row above is a test, plus the default-deny case.

---

## 8. Modules

Each specification lists what the module owns, its public interface, its endpoints, and the tests that must exist before it is done.

### 8.1 `identity`

**Owns:** users, sessions, verification and reset tokens, parent-child links.

**Public:** `signup` · `verifyEmail` · `login` · `logout` · `logoutAll` · `validateSession` · `requestPasswordReset` · `resetPassword` · `generateLinkCode` · `submitLinkCode` · `approveLink` · `revokeLink` · `getLinkedChildren` · `isLinkApproved`

**Endpoints:** `POST /auth/signup` · `GET /auth/verify` · `POST /auth/login` · `POST /auth/logout` · `POST /auth/logout-all` · `POST /auth/forgot-password` · `POST /auth/reset-password` · `POST /links/code` · `POST /links/submit` · `POST /links/:id/approve` · `POST /links/:id/revoke` · `GET /links/children`

**Domain tests:** token length and alphabet · link code excludes ambiguous characters · expiry comparison at the exact boundary · password strength rules.

**Service tests:** signup creates the user, the token, and sends mail · a duplicate email returns the identical response to a new signup · login fails on an unverified email · login is rejected past the rate limit · reset deletes all sessions · a link grants nothing before approval · revoke takes effect immediately · an expired code is rejected · an expired session is rejected.

### 8.2 `learner`

**Owns:** student profile, grade, subjects, chapter mastery.
**Public:** `createProfile` · `getProfile` · `updateProfile` · `getSubjects` · `getMastery` · `updateMastery`
**Endpoints:** `GET /me/profile` · `PATCH /me/profile` · `POST /me/onboarding` · `GET /me/mastery`
**Tests:** grade accepts only the strings `"6"` to `"12"` · **grade `6` as a number is rejected** · mastery clamps to 0..1 · onboarding is idempotent · a student cannot read another student's profile.

### 8.3 `content`

**Owns:** chapters, questions, RAG chunks.
**Public:** `getChapter` · `listChapters` · `getQuestionsForChapter` · `getChunksByIds`
**Endpoints:** `GET /content/chapters` · `GET /content/chapters/:id`
**Tests:** questions are filtered by grade and subject · inactive questions are never returned · a question with other than 4 options is rejected · `correct_index` outside 0..3 is rejected.

### 8.4 `retrieval`

**Owns:** hybrid search, ranking, the abstention decision. **Not prompts.**

**Public:** `search(query, filters): Promise<RetrievalResult>` — the result carries `chunks`, `scores`, `shouldAbstain`, `confidence`.

**Pipeline — one path, no alternatives:**
1. Normalise the query; detect the language.
2. Embed via the `embed` port.
3. Dense search — pgvector HNSW, top 50, **hard filtered** by grade and subject.
4. Sparse search — full text, top 50, same filter.
5. Reciprocal rank fusion, constant 60.
6. Take the top N. **N is 3 at launch, not 8** — ranks 4 to 8 rarely change the answer and always cost tokens.
7. Abstain if the fused top score falls below the threshold.

**The threshold is measured, never guessed.** Before it ships: run 50 known-good questions and 20 deliberately off-syllabus ones, plot the two score distributions, place the threshold between them, and record that measurement in a comment beside the constant. The previous system guessed a value and silently filtered out every result for a year without anyone noticing.

**Tests:** filters always apply — a grade 7 query never returns grade 9 content · fusion ranks a document appearing in both lists above one appearing in only either · abstention triggers below the threshold · an empty result abstains rather than throwing · an embedding failure raises `DependencyError` rather than returning silent garbage.

### 8.5 `foxy`

**Owns:** chat sessions, modes, prompt assembly, citations, traces.
**Public:** `startSession` · `sendMessage` (returns a stream) · `getSession` · `listSessions` · `getTranscript`
**Endpoints:** `POST /foxy/sessions` · `POST /foxy/sessions/:id/messages` (SSE) · `GET /foxy/sessions` · `GET /foxy/sessions/:id`

**Flow:** check the usage limit → load the student's grade and subjects → call `retrieval.search` → if abstaining, return the abstention message and stop → assemble the prompt for the mode → stream from the `llm` port → extract citations → **verify every citation refers to a chunk that was actually retrieved** → persist the message and the trace.

That verification step is the difference between a citation and a decoration. A language model will happily invent a page number.

**Tests:** each mode produces its own prompt shape · abstention returns the abstention message and **never calls the language model** · a fabricated citation is stripped before the response is sent · the usage limit blocks a message once exceeded · a trace row is written for every turn · a mid-stream model failure yields a graceful partial response rather than a 500 · a student cannot read another student's session.

### 8.6 `practice`

**Owns:** quiz sessions, scoring, XP, progress.
**Public:** `startSession` · `submitSession` · `getHistory` · `getProgress`
**Endpoints:** `POST /practice/sessions` · `POST /practice/sessions/:id/submit` · `GET /practice/history` · `GET /practice/progress`

**Domain functions — all pure:**
- `calculateScore(correct, total)` = `Math.round((correct / total) * 100)`. This exact expression, in exactly one place in the codebase.
- `calculateXp(correct, scorePercent)` — points per correct answer, a bonus at 80 percent or above, a further bonus at 100 percent. **Every constant lives in `domain/xp-rules.ts` and nowhere else.**
- `validateAttempt(responses, questionCount)` — three checks: average time at least 3 seconds per question; not every answer the same index when there are more than 3 questions; response count equals question count.

**Submission is one transaction:** write responses, write the session with its score, append to the XP ledger, update mastery. All of it lands or none of it does. A partial write means a student's XP disagrees with their history permanently.

**Domain tests:** 7 of 9 is 78 · 0 of 10 is 0 · 10 of 10 is 100 · division by zero handled · XP at each bonus boundary, tested at 79, 80, 99 and 100 · daily cap clamping · each anti-cheat rule both passing and failing · exactly 3 identical answers is allowed, 4 is not.

**Service tests:** a valid submission writes every table · an invalid attempt scores zero and records a reason · submitting the same session twice is rejected · a partial failure rolls everything back · the XP total equals the sum of the ledger.

### 8.7 `parent`

**Owns:** weekly snapshot, digest, transcript access, consent.
**Public:** `getSnapshot` · `getDigest` · `generateDigest` · `getChildTranscript`
**Endpoints:** `GET /parent/children` · `GET /parent/children/:id/snapshot` · `GET /parent/children/:id/digest` · `GET /parent/children/:id/transcript`

**Every one of these calls `assertCanAccess` first.** No exceptions, no shortcuts.

**Digest generation** runs weekly as a job. It reads the child's Foxy traces and practice results for the week, asks the language model for a five-line summary, and stores it. The summary **names a misconception and one concrete action** — never a percentage. "She is confusing mass with weight" is useful to a parent; "60 percent in Science" is not.

**Tests:** a parent with an approved link can read · a parent with a pending link is denied · a parent with a revoked link is denied · an unlinked parent is denied · **the deny response contains no student data whatsoever** · digest generation is idempotent for a given week · a week with no activity produces a graceful message rather than an empty digest.

### 8.8 `billing`

**Owns:** subscriptions, payment verification, entitlements.
**Public:** `createSubscription` · `handleWebhook` · `getEntitlements` · `cancelSubscription`
**Endpoints:** `POST /billing/subscribe` · `POST /billing/webhook` · `GET /billing/status`

**Webhook rules, in order and non-negotiable:**
1. **Verify the signature before parsing anything.** An unverified webhook is attacker-controlled input.
2. Insert into `payment_events` keyed by the provider's event id. A unique-constraint violation means it is a duplicate — return 200 and stop.
3. Update the subscription **in the same transaction** as the event row.
4. On failure, return 5xx so the provider retries. Never swallow an error and return 200.

**Tests:** a forged signature is rejected · a replayed event is a no-op · a status change and its payment record are written atomically · a failure returns 5xx · entitlements reflect the current status · **an expired subscription cannot access paid features**.

### 8.9 `notify`

**Owns:** email and in-app notifications.
**Public:** `send` · `listForUser` · `markRead`
**Tests:** every notification has both English and Hindi text · a mail-port failure does not break the calling flow · notifications are scoped to their owner.

---

## 9. Testing

### 9.1 The three levels

| Level | What it covers | Speed | Where | Proportion |
|---|---|---|---|---|
| **Unit** | `domain/` — pure functions, no I/O | milliseconds | `modules/*/__tests__/` | ~70% |
| **Service** | A use-case with fake ports and a real database | fast | `modules/*/__tests__/` | ~25% |
| **Integration** | A real HTTP request through the whole stack | slower | `tests/integration/` | ~5% |

**Use a real Postgres for service and integration tests, in a container, via `testcontainers`.** Never fake the database. Faked databases hide exactly the bugs you need to find: constraint violations, transaction behaviour, and the difference between what your query means and what SQL does.

Fake the language model, the embedding service, the mailer and the payment provider — they are slow, cost money, and are non-deterministic.

### 9.2 The rule

**A feature is not done until its tests pass.** Not "tests afterwards". Write the domain test first — it takes two minutes and it forces you to decide what the function actually means before you write it.

### 9.3 What must be tested — the checklist for every function

1. The happy path.
2. Every boundary value. If the rule is "80 or above", test 79 and 80. If it is a range, test both ends and one past each.
3. Every error path. What happens on empty input, null, zero, a negative number, a wrong type.
4. Every branch. If there is an `if`, both sides have a test.
5. Every security rule. If a function checks access, there is a test that access is denied.

### 9.4 Coverage

| Area | Minimum | Why |
|---|---|---|
| `platform/authz/` | **100%** | An access-control gap is not a bug, it is an incident |
| `modules/*/domain/` | **95%** | Pure functions. There is no excuse |
| `modules/*/service.ts` | 80% | |
| Everything else | 70% | |

Coverage is a floor, not a goal. 100% coverage of tests that assert nothing is worthless. The checklist in 9.3 is what actually matters.

### 9.5 Test hygiene

- One assertion concept per test. A test named `it('works')` that asserts nine things tells you nothing when it fails.
- Test names state the behaviour: `it('rejects a submission where every answer is the same index')`.
- No shared mutable state between tests. Each test builds its own data through a fixture factory.
- Never assert on the current date. Use the `clock` port.
- No `sleep`. If a test needs to wait, the code needs an injectable clock.
- A flaky test is a broken test. Fix it or delete it — never re-run it until it passes.

---

## 10. Build order

Strictly sequential. Each step is usable before the next begins.

| # | Step | Done when |
|---|---|---|
| 1 | Repo, TypeScript, ESLint (including the boundary rules), Vitest, Docker Compose with Postgres and Valkey | `npm test` runs and passes with zero tests |
| 2 | `platform/config`, `errors`, `logger`, `db`, `clock`, `idGen` | The server boots and refuses to boot without required environment variables |
| 3 | Drizzle schema for `identity`; first migration | Migration applies and rolls back cleanly |
| 4 | **`identity` module in full** — signup through linking, with every test in 8.1 | You can sign up, verify, log in, and link accounts by HTTP |
| 5 | `platform/authz` with 100% coverage | Every row of the table in Section 7 is a passing test |
| 6 | **Corpus migration script**; `content` module | A hand-run vector query and a full-text query both return sensible rows |
| 7 | `platform/embed` and `platform/llm` ports with fakes | Fakes work in tests; real adapters work against the live services |
| 8 | `retrieval` module, **including threshold calibration** | The measurement is recorded; abstention tests pass |
| 9 | `learner` module | Onboarding works end to end |
| 10 | `foxy` module | A streamed, cited answer over SSE, with a trace row written |
| 11 | `practice` module | Full submission cycle, atomic, with every domain test green |
| 12 | `parent` module | Snapshot, digest and transcript, all access-gated |
| 13 | `billing` module | Subscribe, webhook, entitlement |
| 14 | `notify` module | Email and in-app both delivered |
| 15 | Integration test suite; deployment | Both user journeys pass against a real database |

**Steps 4, 5 and 6 are the ones that must not be rushed.** Everything above them depends on them being right, and mistakes there are expensive to unwind later.

---

## 11. Definition of done

A module is done when **all** of the following are true:

- Every function has an explicit return type; there is no `any`.
- Every input is validated by Zod at the boundary.
- Every function that can fail throws a typed `AppError`.
- Every data-touching service method calls `assertCanAccess`.
- Every domain function has unit tests covering the checklist in 9.3.
- The service has tests against a real database.
- Coverage meets the floor in 9.4.
- Route handlers are under 100 lines and contain no business logic.
- Nothing outside the module imports anything but its `index.ts`.
- No secret, email address, phone number or password appears in a log line.
- The public interface in `index.ts` is documented with one line per exported function.
