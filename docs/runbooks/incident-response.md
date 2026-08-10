# Runbook — Incident Response

**Every alert the evaluator can send, what it means, and what to do about it.**

Each `##` heading below is the anchor a rule points at
(`backend/scripts/ops/alert-rules.ts`, field `runbook`). A unit test asserts
every rule carries such an anchor — an alert that arrives with no instructions
is an alert that gets acknowledged and ignored.

---

## 0. First, orient

```bash
cd docker
C="docker compose -f compose.prod.yml --env-file .env.prod"

$C ps                                   # what is running
$C exec backend-api node -e "fetch('http://127.0.0.1:4000/health/deps').then(r=>r.text()).then(console.log)"
$C logs backend-api --tail 200
$C logs backend-alerts --tail 100       # what the alerter itself saw
```

`/health/deps` is the one place that reports **every dependency plus every
circuit-breaker state**, and it answers from memory — so it still answers when
the database does not.

### The three health endpoints are not interchangeable (§8)

| Endpoint | Question | Failing means |
|---|---|---|
| `/health/live` | is the process alive? | Docker restarts it |
| `/health/ready` | should it take traffic? | the proxy stops routing; **the process is NOT restarted** |
| `/health/deps` | what is the state of everything? | nothing routes on it; it is for you |

---

## 1. Severity: what pages and what does not

| Severity | Delivered on | Means |
|---|---|---|
| **page** | email + in-app | the product is down, about to be down, or silently doing the wrong thing |
| **ticket** | in-app only | degraded but serving, or a trend |

The split is deliberate and conservative. Paging on everything trains people to
ignore the pager, and after that a real outage arrives as a notification
somebody swipes away at 3am.

---

## <a id="readiness-failing"></a>2. `readiness_failing` — PAGE

**`/health/ready` is not returning 200. Traffic is not being routed.**

1. Is it the database? `$C exec postgres pg_isready -U "$POSTGRES_USER"`.
   Readiness checks database reachability, migrations applied, config loaded.
2. If the database is up, read the readiness response body — it names the check
   that failed.
3. **Do not restart the API to "fix" it.** Readiness failing is by design *not* a
   restart condition (§8): if the database blipped, restarting every replica
   turns a 10-second blip into a multi-minute outage. Liveness is what restarts
   things, and liveness deliberately touches nothing external.
4. If a deploy is in flight, this is the expected transient state — check
   whether a deploy is running before treating it as an incident.

**Resolution path:** whatever made the dependency unavailable. Readiness
recovers on its own once it does; there is nothing to reset.

---

## <a id="database-pool-saturated"></a>3. `db_pool_saturated` — PAGE

**≥90% of `max_connections` in use.** §2, F4 — the most under-estimated failure
in the model, and the most common way a healthy application appears to be
completely down.

```sql
-- Who is holding connections, and what are they doing?
select pid, state, wait_event_type, wait_event,
       now() - query_start as running_for, left(query, 120)
  from pg_stat_activity
 where datname = current_database()
 order by query_start;

-- Anything running for minutes is the suspect.
select pg_cancel_backend(<pid>);   -- polite: cancel the query
select pg_terminate_backend(<pid>); -- rude: kill the connection
```

**Find the query before raising `max_connections`.** Raising it converts a
connection problem into a memory problem and buys perhaps ten minutes. The
bulkheads (§3.1 — `auth` 10, `core` 20, `ai` 8, `worker` 6) mean that even
saturated, **login should still work**; if it does not, something is bypassing
`poolFor()` and that is the actual defect.

---

## <a id="circuit-breaker-open"></a>4. `breaker_opened` — PAGE

**A breaker transitioned into OPEN.** Calls to that dependency are now rejected
immediately with no network attempt.

1. `/health/deps` names the port: `llm`, `embed`, `mail`, `payments`, `cache`.
2. Look up the row in the degradation matrix (§6) to know what a user sees:

| Down | What still works |
|---|---|
| LLM | everything except Foxy. Practice, progress, parent, auth, billing all fine |
| Embeddings | Foxy still answers, keyword-only retrieval |
| Valkey | everything; auth rate limiting degrades to in-process (see §5 below) |
| Email | signup completes, verification is queued |
| Payments | existing subscriptions honoured, new checkout disabled |

3. The breaker recovers itself: OPEN → 30s → half-open → 3 trial calls → closed.
   **There is nothing to reset by hand and no reason to restart the process.**
   A restart re-closes every breaker at once and sends the full load straight
   back at a dependency that is still failing.
4. If it flaps for more than ~15 minutes, use the kill switch for that path
   (§9 of the resilience plan — `foxy_enabled`, `retrieval_rerank`) rather than
   letting every request pay the timeout.

---

## <a id="rate-limit-fallback"></a>5. `rate_limit_fallback` — PAGE

**The cache is unavailable, so authentication rate limits have degraded to
per-instance and weaker (D-034).**

This one pages even though the product is up, and that is the point. D-034: *"a
silent fallback is a silent security downgrade — the whole point is that
somebody finds out."* Login still works; brute-force protection is reduced right
now.

1. `$C exec valkey valkey-cli ping` — the usual cause is simply Valkey being
   down.
2. Restart it: `$C up -d valkey`. Counters are lost, which resets every window
   once. That is acceptable and expected.
3. Link codes are **not** affected — they are rows in Postgres, not cache
   entries (D-021).
4. If the cache outage will be long, consider `signup_enabled=false` as a
   temporary measure if you see abuse in the logs.

---

## <a id="worker-heartbeat-stale"></a>6. `worker_heartbeat_stale` — PAGE

**No worker has written a heartbeat in 5 minutes.** The worker has no HTTP
surface, so this row is its only liveness signal (§3.2).

```bash
$C ps backend-worker
$C logs backend-worker --tail 200
$C exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c 'select worker_id, status, last_beat_at, now() - last_beat_at as age, jobs_processed from worker_heartbeats order by last_beat_at desc'
```

- `status = 'draining'` with a recent beat: it is shutting down. Expected during
  a deploy.
- A row that is hours old with no container: the corpse of a previous process.
  Harmless, and deliberately left visible.
- No container at all: `$C up -d backend-worker`.

**Users see nothing while the worker is down** (§3.2) — jobs pause and resume.
What stops is digests, retention nudges and the expired-session sweeper. Jobs
are not lost; a stuck `running` job is returned to the queue by the reaper.

---

## <a id="dependency-error-rate"></a>7. `dependency_error_rate_high` (PAGE) / `dependency_errors_elevated` (TICKET)

**Port timeouts + breaker rejections + concurrency rejections, summed over the
window.** This signal moves *before* user-visible failures do.

It is deliberately **not** an HTTP 5xx rate. Nothing emits a per-request metric —
`metrics_events` is explicit that a row per request is the one thing that would
make a table the wrong sink — so the error rate that exists is the one measured
at the ports.

1. `/health/deps` shows which port is contributing.
2. Rising timeouts with breakers still closed = a dependency getting slower.
   That usually precedes an open breaker by a few minutes; it is the window in
   which a kill switch is cheap.
3. Concurrency rejections without timeouts = more in-flight demand than the port
   allows (§3.3: `llm` 20, `embed` 10, `mail` 5, `payments` 5). This is the
   bulkhead working. Raising the limit trades a fast rejection for a slow one.

---

## <a id="job-dead-lettered"></a>8. `job_dead_lettered` (TICKET) / `job_dead_letter_storm` (PAGE)

**A job exhausted every attempt.** One is a bug in one job; ten is the queue
failing.

```sql
select kind, count(*), max(updated_at)
  from jobs where status = 'dead'
 group by kind order by 2 desc;

select id, kind, attempts, last_error, updated_at
  from jobs where status = 'dead' order by updated_at desc limit 20;
```

§6, rule 3 — *never lose written work* — still holds: the row is there and can
be replayed. To replay, set `status='pending'`, `attempts=0`,
`run_after=now()`. **Do not change `idempotency_key`**: `(kind,
idempotency_key)` is UNIQUE and that constraint is the entire deduplication
mechanism (D-069). A new key makes it a new job and silently removes the
protection.

---

## <a id="notifications-failing"></a>9. `notify_delivery_failing` — TICKET

**Channel deliveries are failing.** Per *channel*, not per notification — the
in-app fallback may still have landed.

- Email failing alone: the mail provider. The in-app row was still written and
  the user finds it when they open the app.
- **In-app failing** is the serious one: it needs only an INSERT, so a failure
  means the database refused the row — usually a foreign key to a deleted user,
  or a missing tenant.

Known gap: *"the notification reached NOBODY on any channel"* is logged at
`error` (`notify.undeliverable`) but has **no metric**, so no rule watches it. A
rule that did would never fire. See D-146.

---

## 10. When the alerting itself is the problem

Two failure modes, both of which look like silence:

1. **`alerts.collector_failed` in the evaluator's log** — a signal could not be
   measured this cycle. Every rule on that signal is disabled while that lasts.
   The evaluator logs it at `error` for exactly that reason; an unmeasurable
   signal is a blind spot, and a blind spot in the alerter is itself an incident.
2. **`alerts.undeliverable`** — an alert reached nobody. The condition it
   described is still true. This is the one failure that cannot report itself.

Check the evaluator is even running:

```bash
$C ps backend-alerts
$C logs backend-alerts --tail 50 | grep alerts.cycle
```

`ALERT EMAIL IS GOING TO STDOUT` in its startup log means `ALERT_MAIL_TRANSPORT`
is still `console`: page-severity alerts are being written to a container log
and **will not reach a phone**. That is a deliberate, visible warning rather than
a silent downgrade, and it is only acceptable while somebody is watching the
logs.

---

## 11. Escalation and the rollback decision

If any of the following is true, **roll back first and diagnose afterwards** —
see `docs/runbooks/deploy-rollback.md`:

- the incident started within 30 minutes of a deploy;
- readiness has been failing for more than 5 minutes with no identified cause;
- the error rate is rising rather than plateauing.

**Rollback target: under 10 minutes from decision to healthy.** Diagnosis is
cheaper on a system that is serving traffic than on one that is not.
