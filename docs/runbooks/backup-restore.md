# Runbook — Backup and Restore

**04-RESILIENCE-PLAN.md §7. Read this when the database is gone, when a
migration went wrong, or once a month because it is a calendar item.**

> **A backup that has never been restored is not a backup.** The drill in
> section 4 is the single most important operational practice in this document.
> If you only ever read one section, read that one.

Everything here is written as numbered steps because it will be read at 2am by
somebody who is frightened. Do not improvise; the steps are ordered so that
nothing destructive happens before something recoverable has been verified.

---

## 0. What exists, in one paragraph

Postgres archives every WAL segment continuously to a **second volume**
(`foxxy_prod_backup_data`, mounted at `/backup`), and the `backup` container
takes a full **base backup** every night at `BACKUP_AT_UTC` (default 02:30 UTC =
08:00 IST). A base backup plus the WAL written since it is point-in-time
recovery: you can restore to *any instant* covered by the archive, not only to
last night.

| What | Where | Written by |
|---|---|---|
| WAL segments | `/backup/wal/` | Postgres `archive_command` (compose.prod.yml) |
| Base backups | `/backup/base/<UTC timestamp>/` | `docker/backup/full-backup.sh`, nightly |
| Row counts at backup time | `/backup/base/<ts>/rowcounts.txt` | the same script |
| Which database was counted | `/backup/base/<ts>/DATABASE` | the same script |

The backup volume is **separate from the data volume on purpose**. A backup on
the same volume as the data it protects is not a backup; it is a copy that dies
in the same incident.

---

## 1. Check the backups are healthy (do this before you need them)

```bash
cd docker

# 1.1  Are base backups being taken?
docker compose -f compose.prod.yml --env-file .env.prod exec backup \
  ls -1t /backup/base | head -5

# 1.2  Is WAL being archived? The newest file should be minutes old, not hours.
docker compose -f compose.prod.yml --env-file .env.prod exec backup \
  sh -c 'ls -lt /backup/wal | head -5; ls /backup/wal | wc -l'

# 1.3  Is the archiver actually succeeding? failed_count MUST be 0.
docker compose -f compose.prod.yml --env-file .env.prod exec postgres \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c 'select archived_count, last_archived_wal, last_archived_time,
             failed_count, last_failed_wal, last_failed_time
        from pg_stat_archiver'
```

**If `failed_count` is climbing:** the archive is failing and Postgres is
retaining WAL in `pg_wal` until the disk fills. This is an urgent, silent
disk-space incident. The usual cause is permissions on `/backup/wal` — it must
be owned by uid 999. Fix with:

```bash
docker run --rm -v foxxy_prod_backup_data:/backup alpine:3.20 \
  sh -c 'chown -R 999:999 /backup'
```

### <a id="nightly-backup-missing"></a>1.4 The "no recent database backup" alert fired

The alert (`backup_stale`, **page**) means the newest completed base backup is
more than 36 hours old.

1. `docker compose -f compose.prod.yml --env-file .env.prod logs backup --tail 100`
   — the loop logs one line per attempt and `ERROR: base backup FAILED` on a bad
   one. It never exits on failure, by design, so the container being *up* says
   nothing.
2. Run one by hand and watch it:
   `docker compose ... exec backup /opt/backup/full-backup.sh`
3. Common causes, in order of likelihood: the backup volume is full
   (`df -h` inside the container); the postgres password changed and
   `.env.prod` was updated but the `backup` container was not recreated;
   `max_wal_senders` was lowered below 1, which makes `--wal-method=stream`
   fail.
4. **WAL archiving is independent of this.** If archiving is healthy the data is
   still protected — but only back to the last base backup, so fix it today.

---

## 2. Take a backup right now (before a risky change)

Always do this before a migration you are not certain about.

```bash
cd docker
docker compose -f compose.prod.yml --env-file .env.prod exec backup \
  /opt/backup/full-backup.sh
```

It prints the directory it created. **Write that timestamp down** — it is the
`--backup` argument in section 3.

---

## 3. Restore

> **Read this whole section before running anything.** Step 3.4 is the only
> destructive step and it comes last, deliberately.

### 3.1 Decide what you are restoring to

| Situation | Target |
|---|---|
| The volume is lost / the disk failed | latest base + all WAL (default) |
| A bad migration at 14:07 | `--target-time '2026-08-10 14:06:00+00'` |
| A mistaken `DELETE` | `--target-time` one minute before it |

For a point-in-time restore, **find the time first** and write it down. Guessing
and re-running is expensive; each attempt replays the whole WAL chain.

### 3.2 Restore into a NEW volume, never over the live one

```bash
cd docker/backup

./restore.sh \
  --target-volume foxxy_restore_$(date -u +%Y%m%d%H%M) \
  --container foxxy-restore \
  --target-time '2026-08-10 14:06:00+00'      # omit for "as recent as possible"
```

The script refuses to write to `foxxy_prod_postgres_data` or
`foxxy_postgres_data`. It mounts the backup volume read-only and forces
`archive_mode = off` in the restored instance — **without that, the restored
copy writes its own divergent timeline into the production WAL archive and
destroys the chain every other backup depends on.**

When it finishes it prints how many WAL segments it fetched from the archive. If
that number is 0, the restore used only the WAL bundled inside the base backup —
a valid restore of that backup, but *not* point-in-time recovery.

### 3.3 Verify the restored copy BEFORE you swap anything

```bash
docker exec -it foxxy-restore psql -U postgres -d foxxy

-- Is the data there?
select count(*) from chapters;      -- expect ~137
select count(*) from rag_chunks;    -- expect ~4686
select count(*) from questions;     -- expect ~2741

-- Is the thing you were recovering FROM actually undone?
select ... ;                        -- the specific rows that prompted this
```

Compare against `rowcounts.txt` in the backup directory. Do not proceed until
the numbers make sense. **A restore you have not looked at is a second
outage waiting to be discovered.**

### 3.4 Swap it in

```bash
cd docker

# 1. Stop everything that writes. Order matters: the worker and the alert
#    evaluator hold connections and will reconnect to the OLD volume otherwise.
docker compose -f compose.prod.yml --env-file .env.prod \
  stop backend-api backend-worker backend-alerts backup

# 2. Keep the damaged volume. Do NOT delete it — it is the evidence, and it is
#    the fallback if the restore turns out to be wrong.
docker volume create foxxy_prod_postgres_data_damaged_$(date -u +%Y%m%d%H%M)
#    (copy it aside; do not rename in place)
docker run --rm \
  -v foxxy_prod_postgres_data:/from \
  -v foxxy_prod_postgres_data_damaged_$(date -u +%Y%m%d%H%M):/to \
  alpine:3.20 sh -c 'cp -a /from/. /to/'

# 3. Replace the live volume's contents with the verified restore.
docker compose -f compose.prod.yml --env-file .env.prod stop postgres
docker run --rm \
  -v <the restore volume>:/from \
  -v foxxy_prod_postgres_data:/to \
  alpine:3.20 sh -c 'rm -rf /to/* && cp -a /from/. /to/ && chown -R 999:999 /to'

# 4. Start, in dependency order.
docker compose -f compose.prod.yml --env-file .env.prod up -d postgres
docker compose -f compose.prod.yml --env-file .env.prod up -d backend-api backend-worker backend-alerts backup

# 5. Confirm.
docker compose -f compose.prod.yml --env-file .env.prod exec backend-api \
  node -e "fetch('http://127.0.0.1:4000/health/ready').then(r=>console.log(r.status))"
```

### 3.5 Immediately afterwards

1. **Take a fresh base backup** (section 2). The restored instance is on a new
   timeline; the old base backups are still valid for the old timeline, but the
   first backup on the new one should exist before anybody goes to bed.
2. Record what happened in `docs/03-DECISION-LOG.md`.
3. Delete the damaged-volume copy only after a week.

---

## 4. The restore drill — run this monthly

```bash
cd docker/backup
./restore-drill.sh
```

It restores the latest backup into a **scratch** database, compares every table
against the row counts recorded at backup time, and prints PASS or FAIL. It
touches nothing live: the backup volume is read-only and the scratch volume is
named after the run.

**Reading the output:**

- `RESTORE DRILL: PASS` — the backup restores and contains what it claimed.
- `RESTORE DRILL: FAIL` — **treat as an incident.** The scratch instance is left
  running on purpose so you can inspect it. You do not have working backups
  until this passes.
- `every expected count was zero` — the drill refuses to pass on this. It means
  the backup is of an empty database, and a comparison of zeros against zeros
  proves nothing.

### 4.1 Prove the drill itself still works

A drill that always passes is worse than no drill. Once a quarter, and after any
change to the backup scripts:

```bash
cd docker/backup
./drill-selftest.sh
```

It builds a scratch stack with known contents, backs it up with the real
`full-backup.sh`, runs the drill twice — once against a good backup (must PASS)
and once against a tampered expectation (must FAIL) — and destroys everything it
made. If the negative case passes, the drill is decoration and the script says
so.

---

## 5. Retention, and what it means

`BACKUP_RETAIN_DAYS` (default 14) bounds both halves: base backups older than
that are deleted, and then WAL older than the **oldest surviving base backup**
is deleted with `pg_archivecleanup`. The order matters — pruning WAL first can
remove segments a surviving base still needs.

**Consequence:** the oldest point you can recover to is the oldest surviving
base backup, not 14 days ago in general. If you need to recover to a point
before that, you cannot, whatever the WAL directory contains.

---

## 6. Off-host replication — THE GAP

Everything above protects against data corruption, a bad migration and a lost
data volume. **It does not protect against losing the host**, because the backup
volume lives on the same machine.

`docker/compose.prod.yml` deliberately does not ship a chosen off-site target: a
half-configured object-store credential is worse than an honest gap, because it
looks like a solved problem. What must be added before this is a complete
answer:

1. A scheduled sync of `foxxy_prod_backup_data` to object storage in a different
   failure domain (`restic` or `rclone`, encrypted, with its own credentials).
2. That target must be included in the monthly drill — an off-site backup that
   has never been restored *from off-site* is exactly the thing §7 warns about,
   one level up.
3. The CMS database and media, as one recoverable set with the product database
   (06-FRONTEND-SEPARATION-PLAN.md).

Until then, state it plainly in any availability conversation: **a host loss is
a data loss.**
