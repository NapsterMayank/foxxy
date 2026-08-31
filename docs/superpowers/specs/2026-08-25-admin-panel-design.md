# Admin panel — design

**Status:** approved 25 August 2026. Track A. Implementation in progress.
**Decisions this rests on:** D-401 (visit correlation), D-073 (tenant NOT NULL), D-063 (append-only audit), D-075 (no hand-maintained lists).

---

## 0. What it is

A read-only operations surface for one internal operator. Two halves, both asked for:

1. **See how monitoring actually works** — every alert signal's live value beside the threshold that would fire on it, the rules themselves, and a dry-run evaluation that delivers nothing.
2. **See everything** — users, learners, practice, Foxy sessions and retrieval traces, billing, audit, content coverage.

It writes nothing. Not "writes little" — the repository contains no `insert`, `update` or `delete`, and a lint rule enforces that.

### Why it exists now

The monitoring machinery is substantial and invisible. Eleven alert rules, a `metrics_events` sink, worker heartbeats, a job queue, `/health/live|ready|deps`, pool saturation and a breaker bridge — all of it reachable only through `npm run ops:alerts` and psql. A system whose health can only be inspected by its author is a system with one operator for ever.

### Explicitly out of scope

No writes of any kind: no job retry, no question deactivation, no session revocation, no user editing. No teacher or principal surface (roadmap Phase 1 and 4). No content authoring — the register-item-53 pain is real and is a separate build. No schema migration; this feature needs none.

---

## 1. Decisions

| # | Decision | Rejected |
|---|---|---|
| 1 | Read-only, both halves | Monitoring-only (does not answer "see everything"); safe mutations (every write needs its own authz, audit and negative tests) |
| 2 | CLI-seeded `super_admin`, normal login, every read audited | Time-bound elevation grants (correct end state, costs a migration and a day); localhost-only (cannot be demoed); separate credential store (duplicates Argon2id, sessions, rotation) |
| 3 | Separate `admin/` Next.js app | Route group in the product frontend; server-rendered from Fastify; API-only |
| 4 | Live state + thresholds + dry run | State only; drill-down without dry run; historical view (needs a table that does not exist — nothing records that an alert fired) |
| 5 | PII masked server-side, reveal is explicit and audited | Raw (screenshots and shoulder-surfing become the exposure path); never show free text (kills the `retrieval_traces` debugging surface) |
| 6 | One thin `admin` module owning no tables | Calling every other module's service (they are all self-scoped; would mean adding "list anyone's" to eight modules and a bypass to the one proven guard); admin endpoints inside each module (eight role checks, eight audit implementations, one miss is a hole) |

---

## 2. Identity and the gate

**Creation.** `npm run admin:create -- --email <addr> --name <name>`. Inserts `users` with `role='super_admin'`, Argon2id hash, `email_verified_at` set. **Generates the password and prints it once** — a prompt cannot run non-interactively and an env var lands in shell history. Refuses an existing email. Writes an audit row.

No populated-database guard, unlike `db:clear-content`. This is the one script that must work against production; accountability is the audit row, not a refusal.

**Login.** Unchanged — existing `/auth/login`, cookie, sweeper, rate limit, origin check. `SIGNUP_ROLES` stays `student|parent`; the signup path never learns `super_admin` exists.

**Gate.** `requireAdmin` = `requireSession`, then `actor.role === 'super_admin'`. **404, never 403** — a 403 confirms the route exists (client architecture doc §13.2, `RESOURCE_NOT_FOUND` "where existence should not be disclosed").

**The cost, stated plainly.** Admin reads cross-tenant and cross-user, so `assertCanAccess` cannot guard these routes — its contract is deny-on-tenant-mismatch. **Admin deliberately bypasses the one authz primitive that is currently airtight.** Mitigations: the role gate is the only door; an audit row per read; and a route-table enumeration test that fails when any path under `/admin` lacks `requireAdmin`.

Session TTL unchanged (14d idle / 30d absolute). Shorter admin sessions need per-role TTL in identity — follow-up, not this build.

---

## 3. Backend: the `admin` module

`backend/src/modules/admin/` — owns no tables, writes nothing, registered in `app/routes.ts` with injected deps like every other module.

### Endpoints

| Group | Endpoint | Returns |
|---|---|---|
| Overview | `GET /admin/overview` | counts, health roll-up, anything currently firing |
| Monitoring | `GET /admin/monitoring/signals` | every signal: current value, range, consuming rules, measurement failures |
| | `GET /admin/monitoring/rules` | all rules: threshold, comparison, severity, cooldown, runbook, channel order |
| | `POST /admin/monitoring/dry-run` | what *would* fire, delivering nothing |
| | `GET /admin/monitoring/jobs` | queue by status and kind, dead letters, oldest pending age |
| | `GET /admin/monitoring/workers` | heartbeats and liveness |
| | `GET /admin/monitoring/metrics` | recent `metrics_events`, grouped |
| | `GET /admin/monitoring/health` | live / ready / deps |
| People | `GET /admin/users`, `GET /admin/users/:id` | masked |
| | `GET /admin/learners/:id/activity` | reads `v_learner_activity` (D-401) |
| Learning | `GET /admin/practice/sessions[/:id]` | |
| | `GET /admin/foxy/sessions[/:id]` | transcript masked |
| | `GET /admin/foxy/traces/:id` | the debugging surface |
| Money | `GET /admin/billing/subscriptions` | |
| Record | `GET /admin/audit` | the audit log itself |
| Content | `GET /admin/content/coverage` | the NULL-column gap report (D-077) |
| Reveal | `POST /admin/reveal` | one endpoint, not one per resource |

Keyset pagination throughout, matching the `(created_at DESC, id DESC)` shape already used on notifications.

`dry-run` is a POST on an otherwise read-only surface: it writes nothing and delivers nothing, but it *executes*, and that cost should be visible at the call site.

### Read-only, enforced

A custom eslint rule beside the existing `migrations/no-migration-chain`, failing on `insert`/`update`/`delete` in `admin.repository.ts`. The repository already fixes intent with lint rules; this is the same move.

### One rule this amends

`v_learner_activity`'s comment currently reads *"for operations and psql, not for a route"*. An audited, role-gated, deliberately cross-tenant admin route is operations — but the comment as written forbids it. The comment and D-401 are amended to say so explicitly. Changing the rule on the record, not quietly breaking it.

---

## 4. Monitoring: the lift and the dry run

**A move, not a rewrite.** The alerting code is already separated: `collectSignals()` → `{signals, failures}`, `evaluate(rules, signals, now)` → `Alert[]`, delivery apart in `createAlertEvaluator`.

`backend/scripts/ops/{alert-rules,alert-sources,alert-evaluator}.ts` → `backend/src/platform/alerts/`. `alert-evaluator-main.ts` stays in `scripts/` as a thin caller. Tests move with them. Required, not tidy: `src/` must not import from `scripts/`.

**Dry run = `collectSignals()` + `evaluate()`.** No dispatcher is constructed — not built-and-not-called, absent, so delivery is impossible rather than skipped. `readinessUrl` points at the API's own `/health/ready`; it calls itself, as the CLI does.

**Per rule the panel shows** current value · threshold and comparison · would-fire · severity · configured cooldown · runbook path · channel order from `ALERT_CHANNEL_POLICY`.

**Blind spots get equal billing with firings.** `CollectedSignals.failures` lists signals that could not be measured; the collector already logs those at `error` because *"a blind spot in the alerting system is itself an incident — every rule on that signal is now silently disabled."* An unmeasurable signal looks exactly like a healthy one. Own panel, not a footnote.

**Cooldowns are shown as configured, not as live.** `CooldownLedger` is an in-memory class per evaluator process. Under `--loop` it works; under `--once` it starts empty every run, so a sustained breach pages on every tick regardless of `cooldownSeconds`. The panel states this rather than rendering a cooldown state it cannot know.

---

## 5. PII masking and the audited reveal

**Masking is server-side.** If the API returned raw and the browser masked it, the data would sit in devtools and the response cache. DTOs carry masked values only.

- email → `a•••@e•••.test`, TLD kept so test accounts stay spottable
- display name → initials
- chat content → **not returned at all** in lists or detail; role, length and timestamp instead

**`POST /admin/reveal`** takes `{ resourceType, resourceId, fields[], reasonCode }`, returns unmasked values for exactly those fields. One request, one resource, named fields — not a session mode.

**`reasonCode`, not free text, and that is forced.** `audit_log.metadata` says *"IDENTIFIERS AND COUNTS ONLY. Never an email, a phone number, a name, or free text a user typed."* A typed justification is free text. So: a closed set — `support_request`, `incident`, `data_request`, `quality_review`, `abuse_report`. Obeys the existing constraint and is more queryable than prose. The UI may collect optional detail; it is not stored.

**Every admin read is audited, not just reveals.** `admin.read` with resource type, id and count; `admin.revealed` with field list and reason code. `AuditPort.record()` never throws, so auditing cannot break a read.

Real cost: this materially increases `audit_log` growth. Retention there is `TRUNCATE`, a DBA operation, and nothing currently schedules it. Noted, not solved here.

**A property preserved.** `retrieval_traces` carry no student identifier by design — reaching one means going message → session → student, which is the audited path. The debugging surface stays pseudonymous.

---

## 6. The `admin/` app

A second app is already a blessed pattern: `website/` is one, `06-FRONTEND-SEPARATION-PLAN.md` governs it, `npm run check:isolation` proves the apps share no runtime code.

`admin/` — Next.js, `output: 'standalone'`, own Dockerfile, own vitest, dev port 3002. Origin joins `CORS_READ_ORIGINS` and `CORS_WRITE_ORIGINS`.

**Contracts** via its own `scripts/sync-contracts.mjs` copying `backend/src/shared/contracts/` verbatim, `--check` in the gates. Backend still owns every declaration.

**Its own small client, not a copy of the product one.** `frontend/src/lib/api/client.ts` carries SSE coordination, abort-vs-failure semantics and a 401 contract with `SessionProvider`. Admin needs none of it. An ~80-line fetch wrapper is a different simpler thing; copying the 200-line one would create the drift risk that writing the small one avoids.

**No i18n.** P7 requires both languages for anything a *user* reads; this is internal. English chrome. Alert titles and bodies are `BilingualText` and are shown in both on the rule detail — that is what would actually be delivered, so seeing it is the point.

Not inherited: bundle budget, Lighthouse, visual baselines.

**Pages.** Overview · Monitoring (signals, rules, dry run, blind spots) · Jobs · Workers · Users · Learner detail · Practice · Foxy (sessions, transcript, trace) · Billing · Audit · Content coverage.

---

## 7. Testing

No migration, so no round-trip concern. Backend tests, in priority order:

1. **Route-table enumeration** — walk Fastify's registered routes; every path under `/admin` must carry `requireAdmin`. A new admin route added without the gate fails the build. The most important test here.
2. **Negative matrix** — student cookie, parent cookie, no cookie, expired session, revoked session, wrong origin. All 404 or 401, never 403, never a body confirming the route.
3. **Masking is server-side** — the raw email and raw chat text are absent from the response bytes, not merely hidden.
4. **Reveal** — writes `admin.revealed` with fields and reason code; rejects an unknown reason code; returns only the requested fields.
5. **Audit carries no PII** — extend the existing test that drives an email and a phone through `record()` and asserts neither lands.
6. **Dry run delivers nothing** — force every signal past its threshold against a dispatcher spy, assert zero calls; stronger, assert no dispatcher is constructed.
7. **Lint rule** — an `insert` in `admin.repository.ts` fails.

Frontend: masking render, reveal flow, dry-run result rendering. No visual baselines.

---

## 8. Sequence

| Phase | Delivers |
|---|---|
| 1 | Alerts lifted into `src/platform/alerts` |
| 2 | `admin:create`, `requireAdmin`, enumeration test, negative matrix |
| 3 | Admin module skeleton + monitoring endpoints |
| 4 | Data endpoints + server-side masking |
| 5 | Reveal, audit-every-read, lint rule |
| 6 | The `admin/` app |

Phases 1–3 give a working monitoring panel. Everything after is the "see everything" half.

**Rollout.** Not deployed publicly to begin with — run locally against the dev database, seed the first admin with the CLI, look at real monitoring. Exposure is a separate decision once it has been seen.
