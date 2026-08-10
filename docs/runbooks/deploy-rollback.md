# Runbook — Deploy and Rollback

**Target: from the decision to roll back, to a healthy system, in under 10
minutes.** Everything below is arranged to make that number achievable rather
than aspirational.

---

## 0. The rules that make a rollback possible

These are not style preferences. Break any one of them and the 10-minute target
becomes unreachable.

1. **Images are tagged immutably.** `BACKEND_IMAGE=foxxy/backend:<git-sha>`, not
   `:latest`. A rollback needs a tag it can go *back* to, and `latest` is not
   one — it is a moving pointer to whatever broke.
2. **Migrations are a separate, explicit step.** Never on boot. A failed
   migration must leave the OLD version running and serving traffic.
3. **Migrations are forward-compatible for one release.** The old code must
   tolerate the new schema, because a code rollback does *not* roll back the
   schema. See section 4.
4. **Nobody runs `docker compose up` against the whole file.** Application
   deploys go through `docker/deploy-app.sh`, which recreates one app's
   containers with `--no-deps` and refuses to name `caddy`, `postgres`,
   `valkey` or `backup`.

---

## 1. Deploy — backend

```bash
cd docker
C="docker compose -f compose.prod.yml --env-file .env.prod"

# 1. Record what is running NOW. This is the rollback target. Do it first,
#    every time — after something is broken is the wrong moment to work out
#    what "before" was.
grep BACKEND_IMAGE .env.prod        # <- write this down

# 2. Pull the new image and MIGRATE, as its own step.
export BACKEND_IMAGE=foxxy/backend:<new-sha>
$C pull migrate
$C --profile migrate run --rm migrate

# 3. CHECK THE CATALOGUE, NOT THE EXIT CODE (D-109).
#    `db:migrate` printing "Migrations applied." does not mean it applied
#    anything: Drizzle skips a migration whose journal timestamp precedes the
#    last applied ledger row, and the development database ran a whole session
#    on the wrong schema because of exactly that.
$C exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "select count(*) from information_schema.tables where table_schema='public'" \
  -c "select * from drizzle.__drizzle_migrations order by created_at desc limit 3"

# 4. Roll the application containers.
./deploy-app.sh backend foxxy/backend:<new-sha>
```

`deploy-app.sh` waits for `/health/ready` and exits non-zero if it never
arrives. **If it exits non-zero, go to section 3 immediately.**

### 1.1 Smoke checks after a backend deploy

```bash
# readiness and dependencies
$C exec backend-api node -e "fetch('http://127.0.0.1:4000/health/ready').then(r=>console.log('ready',r.status))"
$C exec backend-api node -e "fetch('http://127.0.0.1:4000/health/deps').then(r=>r.text()).then(console.log)"

# the worker is beating
$C exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c 'select worker_id, status, now() - last_beat_at as age from worker_heartbeats'
```

### 1.2 <a id="sse-smoke-check"></a>SSE smoke check — do this after ANY proxy or backend deploy

**Foxy's stream is the thing most likely to be broken by an infrastructure
change, and the symptom points at the language model rather than the proxy.**
If the proxy buffers, the user waits in silence for the whole generation and
then receives the entire answer at once. Nothing errors. Nothing logs.

```bash
# Chunks must arrive INCREMENTALLY, with timestamps spread across the response.
# If every line lands at the same instant, the response was buffered.
curl -N -s -D - \
  -H 'Accept: text/event-stream' \
  -H 'Cookie: foxxy_session=<a real session>' \
  https://api.<domain>/api/v1/foxy/sessions/<id>/stream \
  | while IFS= read -r line; do printf '%s  %s\n' "$(date -u +%H:%M:%S.%3N)" "$line"; done
```

Three things to confirm:

1. the first chunk arrives within a few seconds, not at the end;
2. timestamps are spread out;
3. a stream running longer than 60 seconds is **not** severed by the proxy —
   the application's own budget (§4: 8s to first token, 60s total) must be what
   ends it, because the application can send a typed error and the proxy cannot.

The CI `infra` job asserts that `flush_interval -1` and a `read_timeout` of at
least 120s are still present in `docker/caddy/conf.d/20-api.caddy`. That catches
their removal; it cannot catch a runtime regression, which is what this check is
for.

---

## 2. Deploy — frontend and website

```bash
cd docker
./deploy-app.sh frontend foxxy/frontend:<sha>
./deploy-app.sh website  foxxy/website:<sha>
```

A marketing deploy replaces the `website` container and **nothing else** — not
the proxy, not the product, not the database. Confirm after any change to the
marketing pipeline:

```bash
docker compose -f compose.prod.yml --env-file .env.prod ps \
  --format 'table {{.Service}}\t{{.RunningFor}}'
# Only `website` should show a recent start time.
```

---

## 3. Rollback — the 10-minute path

### 3.1 Code only (no migration in this release) — 2 to 3 minutes

```bash
cd docker
./deploy-app.sh backend foxxy/backend:<the PREVIOUS sha>
```

That is the whole procedure. This is why images are tagged immutably and why the
previous tag is written down before the deploy, not after the incident.

### 3.2 A migration was applied — 5 to 10 minutes

**Do not roll the schema back by running the down migration.** A `down` file is
tested for the round-trip property against an empty database; run against
production it drops tables, and *if the new release wrote any rows into them,
those rows are gone*. The down migrations exist to prove the forward ones are
reversible, not to be run in an incident.

Instead, in order of preference:

1. **Roll the CODE back only.** If rule 3 in section 0 held — the release's
   migration is additive (new table, new nullable column, widened CHECK) — the
   previous code runs fine against the new schema. This is the case the rule
   exists to create, and it is the fast path.
2. **Write a compensating migration** if the schema change is genuinely
   incompatible. Forward, small, reviewed. Slower, and correct.
3. **Restore from backup** only if data has been corrupted —
   `docs/runbooks/backup-restore.md`, section 3, with `--target-time` set just
   before the migration ran. This is minutes-to-tens-of-minutes and loses
   everything written since, so it is the last resort, not the first.

### 3.3 After any rollback

1. Confirm readiness and run the SSE smoke check (1.2).
2. Write down what happened while it is fresh: the symptom, the time, the
   decision, the outcome. `docs/03-DECISION-LOG.md`.
3. Add the failure mode to the test suite. A defect that reached production and
   left no test behind will reach production again.

---

## 4. Migration compatibility — the rule that makes 3.1 possible

Every migration must leave the **previous release's code** able to run. In
practice:

| Safe in one release | Needs two releases |
|---|---|
| add a table | drop a table |
| add a nullable column | drop a column |
| add an index | rename a column (add + backfill + read both, *then* drop) |
| widen a CHECK constraint | narrow a CHECK constraint |
| add an enum value | remove an enum value |

D-023 records the one deliberate exception taken so far, and it is bounded and
argued. Take another only with the same care.

The migration round-trip check (`npm run db:round-trip`, and the CI step) proves
a migration is *reversible against an empty database*. It says nothing about
whether it is *compatible with the previous release*. That judgement is human,
and it is made at review time.

---

## 5. What a deploy must never do

- **Restart the proxy to deploy an app.** `deploy-app.sh` uses `--no-deps` for
  precisely this reason; without it, `docker compose up -d website` recreates
  everything `website` depends on.
- **Migrate on boot.** Two replicas means two concurrent migrators racing on one
  lock, and a failed migration becomes a crash-loop that takes the service down
  as well as failing.
- **Deploy the backend and the frontend in one step.** They are separate images
  with separate pipelines so that one can be rolled back without the other.
- **Delete the previous image tag.** It is the rollback target. Keep at least
  the last five.
