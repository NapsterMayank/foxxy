# Resilience Plan

How this system stays up when parts of it fail, and how it grows into separate services without a rewrite.

**Prerequisite:** `00-ARCHITECTURE.md`.

---

## 1. Principle

> **Fault isolation comes from bulkheads, timeouts and degradation paths — not from deployment topology.**

A modular monolith with bulkheads is more available than naive microservices, because every network hop adds failure modes. Five services at 99.9% in a synchronous chain give 99.5% — roughly 3.6 hours of downtime a month against 43 minutes for a single well-built process.

So: **build the isolation first, split later, and split only when a measurement demands it.** Section 10 defines those measurements.

Every requirement in this document is testable. If it cannot be tested, it is a wish.

---

## 2. Failure model

Everything that can fail, and what it costs.

| # | Failure | Likelihood | Blast radius without mitigation |
|---|---|---|---|
| F1 | Language model API slow or down | **High** — it is the least reliable dependency | Every request thread waiting on it blocks. Platform-wide stall |
| F2 | Embedding API slow or down | Medium | Foxy cannot search. Blocks the same threads |
| F3 | Postgres down | Low | **Total outage.** The only true single point of failure |
| F4 | Postgres saturated — connection pool exhausted | **High** | One runaway query path starves every other. Looks like a total outage |
| F5 | Valkey down | Medium | Rate-limit counters fail. Login breaks if it fails closed |
| F6 | Email provider down | Medium | Signup verification never arrives. Funnel stops |
| F7 | Payment provider down | Low | New checkouts fail. Existing subscribers unaffected |
| F8 | One code path leaks memory or spins CPU | Medium | Process death, all requests lost |
| F9 | Bad deploy | Medium | Depends entirely on rollout strategy |
| F10 | Traffic spike on one endpoint | Medium | Starves every other endpoint |

**F4 is the most under-estimated item on this list.** It is the most common way a healthy application appears to be completely down, and it is the cheapest to prevent.

---

## 3. Bulkheads

A bulkhead limits how much of a shared resource one concern can consume, so its failure cannot sink the ship.

### 3.1 Database connection pools — the highest-value isolation

**One pool per concern, each independently capped.** Not one shared pool.

| Pool | Max connections | Serves | Rationale |
|---|---|---|---|
| `auth` | 10 | identity, sessions | **Must never be starved.** If login fails, the product is down regardless of what else works |
| `core` | 20 | learner, content, practice, parent, billing | Ordinary request traffic |
| `ai` | 8 | retrieval, foxy | Vector search is expensive and spiky. Capped so it **cannot** exhaust the others |
| `worker` | 6 | background jobs | Separate process; digests must never compete with live traffic |

Total stays within Postgres `max_connections` with headroom for administrative access.

**Why this matters concretely:** a slow HNSW query under load consumes pool connections. With one shared pool it eventually holds all of them, and login starts failing — an outage caused by search. With separate pools, retrieval degrades and **nothing else notices**.

Verification: a test saturates the `ai` pool and asserts that a login still completes.

### 3.2 Process separation

Already in place. Same codebase, different entry points, independent failure and independent scaling.

| Process | Responsibility | If it dies |
|---|---|---|
| `api` | HTTP requests | Requests fail. Restart is seconds |
| `worker` | Digests, scheduled reviews, cleanup | Jobs pause and resume. **Users see nothing** |

### 3.3 Concurrency limits per dependency

Each external port carries a maximum in-flight request count. Beyond it, calls are rejected immediately rather than queued.

| Port | Max in flight | On overflow |
|---|---|---|
| `llm` | 20 | Reject with `DependencyError`; the caller degrades |
| `embed` | 10 | Reject; retrieval falls back to keyword-only |
| `mail` | 5 | Enqueue for the worker instead |
| `payments` | 5 | Reject; the client retries |

Unbounded queueing is what converts a slow dependency into a dead application. A fast rejection is a better outcome than an infinite wait.

---

## 4. Timeouts

**Every outbound call has a timeout. A call without one is a defect.**

| Call | Connect | Total | Retries |
|---|---|---|---|
| Postgres query | 2 s | 10 s (statement timeout) | none — the caller decides |
| Postgres — vector search | 2 s | 5 s | none |
| Valkey | 500 ms | 1 s | 1 |
| LLM — non-streaming | 3 s | 30 s | 1, only on connect failure |
| LLM — streaming | 3 s | 8 s **to first token**, 60 s total | none once streaming has begun |
| Embeddings | 2 s | 5 s | 2, exponential backoff |
| Email | 3 s | 10 s | 3, handled by the worker |
| Payments | 3 s | 15 s | none on writes — retrying a payment is worse than failing it |

**Rules:**
- Timeouts are configuration, not constants scattered through the code.
- Every timeout is **shorter than its caller's timeout**. Otherwise the caller gives up first and the work is wasted.
- Never retry a non-idempotent write.
- Retries use exponential backoff with jitter. Synchronised retries are a self-inflicted denial of service.

---

## 5. Circuit breakers

A timeout protects one request. A circuit breaker protects the system from a dependency that is already known to be failing — it stops sending traffic that will fail anyway.

Wraps every external port: `llm`, `embed`, `mail`, `payments`, `cache`.

**States**

| State | Behaviour | Transition |
|---|---|---|
| **Closed** | Calls pass through. Failures counted | 5 failures in 30 s, or a 50% failure rate over 20 calls → Open |
| **Open** | Calls rejected immediately with `DependencyError`. No network attempt | After 30 s → Half-open |
| **Half-open** | 3 trial calls allowed | All succeed → Closed. Any fails → Open, with the wait doubled up to 5 minutes |

**Counted as a failure:** timeout, connection error, 5xx.
**Not counted:** 4xx. A malformed request is our defect, not the dependency's.

Every state transition is logged at `warn` and emitted as a metric. **A breaker that opens without anyone knowing is a silent outage.**

---

## 6. Degradation matrix

**These are testable requirements, not aspirations.** Each row is an integration test that disables the dependency and asserts the stated behaviour.

| Dependency down | Foxy | Practice | Progress | Parent | Auth | Billing |
|---|---|---|---|---|---|---|
| **LLM API** | ❌ "Unavailable, try shortly" | ✅ | ✅ | ⚠️ digest deferred, snapshot fine | ✅ | ✅ |
| **Embeddings** | ⚠️ keyword-only retrieval, still answers | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Valkey** | ⚠️ no answer cache, slower | ✅ | ✅ | ✅ | ⚠️ in-process rate limits (built — D-034; link codes are unaffected, they are rows) | ✅ |
| **Email** | ✅ | ✅ | ✅ | ⚠️ digest queued | ⚠️ verification queued, signup completes | ✅ |
| **Payments** | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ new checkout disabled, existing plans honoured |
| **Postgres** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

✅ unaffected · ⚠️ degraded but useful · ❌ unavailable

**Every dependency except the database leaves a working product.** That is the concrete meaning of "one failure must not take down the platform".

**Degradation rules:**
1. **Degrade, never lie.** Keyword-only retrieval is acceptable; a confident answer from an unavailable grounding source is not.
2. **Tell the user.** "Foxy is briefly unavailable" beats a spinner that never resolves.
3. **Never lose written work.** A submitted practice session persists even if XP or notifications fail — those are jobs, retried later.
4. **Degradation is tested.** A path that has never been exercised does not work.

---

## 7. The database — the one real single point of failure

Microservices do not fix this. Sharing a database keeps the same SPOF; a database per service replaces it with distributed transactions, which is a harder problem.

| Mitigation | Stage |
|---|---|
| Statement timeout, so no query runs forever | **Now** |
| Separate connection pools (Section 3.1) | **Now** |
| Continuous WAL archiving; point-in-time recovery | **Now** |
| Nightly backup, offsite, with a **monthly restore drill** | **Now** |
| Read replica for parent and analytics reads | Stage 1 |
| Automatic failover to the replica | Stage 2 |
| Partition high-volume tables by month | Stage 2 |

**A backup that has never been restored is not a backup.** The restore drill is a calendar item, and it is the single most important operational practice in this document.

---

## 8. Health checks

Three endpoints, three different questions. Conflating them causes outages during deploys.

| Endpoint | Question | Checks | On failure |
|---|---|---|---|
| `/health/live` | Is the process alive? | Nothing external. Returns 200 if the event loop responds | Orchestrator restarts the process |
| `/health/ready` | Should it receive traffic? | Database reachable, migrations applied, config loaded | Load balancer stops routing. **Process is not restarted** |
| `/health/deps` | What is the state of everything? | Every dependency plus circuit-breaker state. Never used for routing | Observability only |

**The trap:** if liveness checks the database, a brief database blip restarts every application instance simultaneously — turning a 10-second blip into a multi-minute outage. Liveness must never touch an external system.

---

## 9. Feature flags as kill switches

Every risky path is flag-gated, so it can be disabled in seconds without a deploy.

| Flag | Disables | Use when |
|---|---|---|
| `foxy_enabled` | The AI tutor | Cost spike, prompt regression, safety incident |
| `foxy_streaming` | Falls back to non-streaming | Connection instability |
| `retrieval_rerank` | Skips reranking | Latency spike |
| `practice_enabled` | Practice sessions | A scoring defect in production |
| `digest_generation` | Weekly digest job | Runaway cost or a bad summary |
| `signup_enabled` | New registrations | Abuse or a capacity emergency |

Flags are read from the database and cached for 30 seconds — a flip takes effect within 30 seconds without a restart. Every flag carries an `expires_at`, and the build fails when an expired flag still exists in the code. Flags that never expire become permanent forks in the codebase, which is how the previous system ended up with two divergent retrieval paths.

---

## 10. Extraction triggers

The system is designed to become several services. It becomes them when a **measurement** says so — never because of an architecture diagram.

Because callers only ever import a module's `index.ts`, extraction means replacing that one file's body with an HTTP client. Roughly one to two days per module, no other file changes.

| Module | Extract when | Metric to watch | Expected effort |
|---|---|---|---|
| **`foxy`** — first candidate | p95 latency on non-Foxy endpoints rises measurably while Foxy is under load, **or** it needs more than twice the replicas of the rest | p95 by route, segmented by concurrent Foxy sessions | 2 days |
| `retrieval` | Vector search CPU exceeds 60% of the process budget, **or** the embedding model is self-hosted | CPU share by module; search p95 | 2 days |
| `worker` | Already separate | — | done |
| `billing` | Compliance requires an isolated audit boundary | — | 1 day |
| Everything else | A dedicated team owns it and release cadence conflicts | deploy frequency per module | — |

**Anti-trigger — do not extract because:** it feels cleaner, someone read a blog post, or a diagram looks better. Splitting without a measurement produces a distributed monolith: services that must be deployed together, carrying every cost of microservices and delivering none of the isolation.

**Before any extraction, three things must already exist:** distributed tracing, a per-service error budget, and a rollback path that reverts to the in-process call.

---

## 11. Testing resilience

Untested resilience is decoration. Each mechanism has a specific test.

| Mechanism | Test |
|---|---|
| Connection-pool bulkhead | Saturate the `ai` pool; assert a login still succeeds |
| Timeout | Fake port delays past the timeout; assert `DependencyError`, not a hang |
| Circuit breaker | Drive 5 consecutive failures; assert the next call is rejected **without a network attempt**; advance the injected clock 30 s; assert half-open |
| Retry backoff | Assert the delay sequence and jitter bounds using the injected clock |
| Degradation — every row of Section 6 | Disable the dependency; assert the stated behaviour |
| Rate-limit fallback | Make the cache unavailable; assert login still works under an in-process limiter |
| Health checks | Take the database down; assert `/health/live` stays 200 and `/health/ready` returns 503 |
| Feature-flag kill switch | Flip a flag; assert the path is disabled within 30 s with no restart |
| Graceful shutdown | Send SIGTERM mid-request; assert the in-flight request completes and no new ones are accepted |

The injected `clock` port is what makes breaker and backoff tests deterministic and instant. This is the payoff for building it on day one.

**Quarterly, in staging:** kill the database, kill the cache, and make the LLM API return 500s — with a stopwatch. Confirm the degradation matrix holds in reality, not only in tests. Record the result.

---

## 12. Graceful shutdown

On SIGTERM:

1. Stop accepting new connections; `/health/ready` immediately returns 503.
2. Wait for in-flight requests, up to 15 s.
3. Let the worker finish its current job, up to 30 s; do not claim new ones.
4. Close database pools and the cache connection.
5. Exit 0.

Without this, every deploy drops requests and abandons half-finished jobs. It is a small amount of code that converts routine deploys from user-visible to invisible.

---

## 13. Implementation status

Reconciled after the platform hardening pass, 8 August 2026.

| Item | Status | Where |
|---|---|---|
| Ports for every external dependency | ✅ built | `src/platform/*` |
| Injected clock (needed for deterministic breaker tests) | ✅ built | `platform/clock` — now also a `Sleeper` port, so retry backoff is testable without waiting (D-027) |
| Typed error hierarchy including `DependencyError` | ✅ built | `platform/errors` |
| Separate connection pools (§3.1) | ✅ built | `platform/db/pools.ts` — `auth` 10, `core` 20, `ai` 8, `worker` 6, each with its own statement timeout |
| Concurrency limits per port (§3.3) | ✅ built | `platform/concurrency` — rejects on overflow, never queues |
| Timeout policy applied to every port (§4) | ✅ built | `platform/config/timeouts.ts` — the §4 table, validated at boot |
| Retry with exponential backoff **and jitter** (§4) | ✅ built | `platform/retry` — refuses a retry budget on a non-idempotent call |
| Circuit breakers (§5) | ✅ built | `platform/circuit-breaker`, composed in `platform/resilience`. Wired into `cache` and `http`; wired into the *interface* wrappers for `llm`, `embed`, `mail`, `payments`, so their adapters inherit it (D-029) |
| Statement timeout, so no query runs forever (§7) | ✅ built | Connection parameter per pool — 10s, 5s on `ai` (D-028) |
| `/health/live`, `/health/ready`, `/health/deps` (§8) | ✅ built | `src/app/health.ts`. Liveness touches nothing external; `/health` survives as a deprecated liveness alias (D-024) |
| Graceful shutdown (§12) | ✅ built | `src/app/shutdown.ts` — readiness 503 first, then a 15s drain, then close, then exit 0 |
| Rate-limit in-process fallback | ✅ built | `modules/identity/identity.rate-limit.ts` — on any cache error the counter moves in process for that request, at `warn` plus the `identity.rate_limit.in_process_fallback` metric every time. Deliberately per-instance and weaker: degraded rate limiting beats no authentication (D-034) |
| Origin check on state-changing requests (plan §6.10) | ✅ built | `src/app/plugins/origin-check.ts` — one shared `onRequest` hook over POST/PUT/PATCH/DELETE; allowed origins from config; payment webhooks exempt, with HMAC verification as the compensating control (D-035) |
| Continuous WAL archiving, PITR, restore drill (§7) | ✅ built — 10 August | `docker/compose.prod.yml` (`archive_mode=on`, `archive_timeout=300`, archiving to a SECOND volume) + `docker/backup/`: `full-backup.sh` (nightly base backup, records `rowcounts.txt` and `DATABASE` beside it), `restore.sh` (PITR via `--target-time`; forces `archive_mode=off` so a restored copy cannot corrupt the archive — D-160), `restore-drill.sh`, `drill-selftest.sh`. **The drill has been RUN**: PASS on a good backup, FAIL on a tampered expectation. Runbook: `docs/runbooks/backup-restore.md`. **Open gap: off-host replication of the backup volume — a host loss is still a data loss** (D-149) |
| Alert evaluation and delivery (§5, the second half) | ✅ built — 10 August | `backend/scripts/ops/` — `alert-rules.ts` (pure: 11 rules over 9 signals, page/ticket split, cooldowns), `alert-sources.ts` (reads `metrics_events`, `pg_stat_activity`, `worker_heartbeats`, `/health/ready`, the backup volume), `alert-evaluator.ts` (delivers through the existing `notify-channel` port — never a second notification path). Refuses to start without an on-call recipient (D-147). Runbook: `docs/runbooks/incident-response.md` |
| Production deployment, reverse proxy, CI/CD (§12 in practice) | ✅ built — 10 August | `docker/compose.prod.yml`, three multi-stage non-root Dockerfiles, Caddy with automatic TLS for three hostnames and a **dedicated SSE proxy policy** (D-142), `docker/deploy-app.sh`, `.github/workflows/`. Runbook: `docs/runbooks/deploy-rollback.md` |
| Degradation matrix tests (§6) | ⬜ per module, as each is built | The `cache`, `llm` and `embed` rows are partly covered by the breaker and wrapper tests; the per-module behaviour is not |
| Feature-flag kill switches (§9) | ⬜ with the flags module | |
| Read replica, automatic failover | ⬜ scaling stage 1 and 2 | |

### §11 test coverage — what is actually asserted

| Mechanism | Test | File |
|---|---|---|
| Connection-pool bulkhead | `ai` pool saturated, login still succeeds | `tests/integration/pool-bulkhead.test.ts` |
| Timeout | hanging port yields `DependencyError`, not a hang | `platform/resilience/__tests__/port-guard.test.ts` |
| Circuit breaker | 5 failures → next call rejected **with zero calls to the dependency** → clock +30s → half-open | `platform/circuit-breaker/__tests__/circuit-breaker.test.ts` |
| Retry backoff | delay sequence and jitter bounds, on the injected clock | `platform/retry/__tests__/retry.test.ts` |
| Concurrency limits | overflow rejects immediately and never enters the operation | `platform/concurrency/__tests__/limiter.test.ts` |
| Health checks | database down → `/health/live` 200, `/health/ready` 503 | `src/app/__tests__/health.test.ts` (and the 200 case in `tests/integration/health-ready.test.ts`) |
| Graceful shutdown | SIGTERM mid-request → in-flight completes, new refused | `src/app/__tests__/shutdown.test.ts` |
| Degradation — every row of §6 | ⬜ per module | — |
| Rate-limit fallback | cache unavailable → login still succeeds, and the limit is still enforced within the instance | `modules/identity/__tests__/identity.rate-limit-fallback.test.ts` (service + HTTP, real Postgres) and `identity.rate-limit.test.ts` (branches, on `FixedClock`) |
| Cache outage does not invalidate a link code | cache restart simulated mid-flow → an outstanding code still redeems | `modules/identity/__tests__/identity.service.test.ts`, "link codes live in the database" |
| Origin check | no Origin → 403 · foreign Origin → 403 · allowed Origin → 200 · GET unaffected · webhook prefix exempt | `src/app/__tests__/origin-check.test.ts` |
| Feature-flag kill switch | ⬜ not built | — |
| Alert rules — thresholds, severities, cooldowns, and the guard against a rule watching a signal nothing emits | `backend/tests/ops/alert-rules.test.ts` (23 tests). Includes the case that matters most: an ABSENT signal never fires a rule and is never read as zero (D-148) |
| Restore drill — a real restore into a scratch database, verified against counts recorded at backup time | `docker/backup/restore-drill.sh`; **and the drill's own ability to fail** is proven by `docker/backup/drill-selftest.sh`, which runs it against a known-good backup (must PASS) and a tampered one (must FAIL) |

Every breaker and backoff test runs on `FixedClock` and finishes in milliseconds. Nothing in the suite sleeps.
