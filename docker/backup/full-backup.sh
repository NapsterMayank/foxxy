#!/usr/bin/env bash
# =============================================================================
# ONE nightly full base backup, to the SECOND volume. 04-RESILIENCE-PLAN.md §7.
#
# Runs inside the `backup` container (uid 999), which is on the internal
# network and holds PGPASSWORD. Can also be run by hand at any time:
#
#     docker compose -f docker/compose.prod.yml --env-file docker/.env.prod \
#       exec backup /opt/backup/full-backup.sh
#
# =============================================================================
# PHYSICAL (pg_basebackup), NOT LOGICAL (pg_dump). The reason matters.
#
# A `pg_dump` is a consistent SQL snapshot at one instant and nothing else. It
# cannot be combined with archived WAL, so the best recovery point it can ever
# offer is "last night". Point-in-time recovery — recovering to 14:07, one
# minute before the bad UPDATE — requires a PHYSICAL base backup plus the WAL
# written since. §7 asks for PITR, so the base backup is physical.
#
# It also restores an order of magnitude faster on a corpus this size: 4,686
# chunks each carrying a 1024-dimension vector are ~66 MB of float text in a
# dump and a byte copy in a base backup, and the dump has to rebuild the HNSW
# index afterwards.
#
# =============================================================================
# THE ROW COUNTS ARE PART OF THE BACKUP.
#
# `rowcounts.txt` is written from the LIVE database at backup time and stored
# beside the backup. It is what makes the restore drill a verification rather
# than a vibe: "the restore produced a database that starts" is not the claim
# anybody cares about — "the restore produced the rows that were there" is.
#
# Without a recorded expectation, a drill can only compare a restore against
# the live database, which (a) is not always available in a real recovery and
# (b) silently passes if BOTH are empty.
# =============================================================================
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backup}"
BASE_DIR="${BACKUP_DIR}/base"
WAL_DIR="${BACKUP_DIR}/wal"
RETAIN_DAYS="${RETAIN_DAYS:-14}"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="${BASE_DIR}/${TS}"

log() { echo "[$(date -u +%FT%TZ)] full-backup: $*"; }

mkdir -p "$BASE_DIR" "$WAL_DIR"

# The WAL segment the backup starts at or after, recorded BEFORE the backup
# begins. Conservative on purpose: retention below never deletes WAL at or after
# this segment, so being early costs a few megabytes and being late would cost
# the ability to restore.
START_WAL="$(psql -Atqc "select pg_walfile_name(pg_current_wal_lsn())")"

log "starting base backup -> ${DEST} (start WAL ${START_WAL})"
mkdir -p "${DEST}.partial"

# -Ft -z   tar + gzip: two files, base.tar.gz and pg_wal.tar.gz
# -Xs      stream the WAL generated DURING the backup, so the backup is
#          self-consistent even if the archive is momentarily behind
# -c fast  immediate checkpoint; without it the backup waits for the next
#          scheduled one and a "nightly" backup starts whenever it feels like it
pg_basebackup \
	--pgdata="${DEST}.partial" \
	--format=tar \
	--gzip \
	--wal-method=stream \
	--checkpoint=fast \
	--progress \
	--no-password

echo "$START_WAL" >"${DEST}.partial/START_WAL"

# The row counts, from the live database, at backup time. `to_regclass` so a
# table that does not exist yet (a module not built, a migration not applied)
# records a NULL instead of aborting the backup — a backup that fails because
# `foxy_sessions` is not there yet is a backup you do not have.
# WHICH DATABASE THESE COUNTS CAME FROM, recorded beside them.
#
# Found by the drill self-test: without it the drill connected to the restored
# cluster's DEFAULT database (`postgres`), where none of the tables exist. Every
# `to_regclass` check then returned "absent", every "absent" comparison matched
# the recorded "absent", and ten of the thirteen rows reported `ok` — a drill
# passing on a database it had never looked at. Only the three tables with
# non-zero expectations failed, and only because a count against a missing table
# errors rather than returning 0.
psql -Atqc 'select current_database()' >"${DEST}.partial/DATABASE"

COUNTED_TABLES="${COUNTED_TABLES:-users sessions students chapters rag_chunks questions chapter_concepts concept_graph misconception_patterns practice_sessions practice_responses xp_ledger metrics_events}"
: >"${DEST}.partial/rowcounts.txt"
for table in $COUNTED_TABLES; do
	if [ "$(psql -Atqc "select to_regclass('public.${table}') is not null")" = 't' ]; then
		count="$(psql -Atqc "select count(*) from public.\"${table}\"")"
	else
		# -1, not 0, and not a skipped line. "The table does not exist" and "the
		# table is empty" are different facts, and a drill that cannot tell them
		# apart passes on a restore that lost a table.
		count=-1
	fi
	echo "${table} ${count}" >>"${DEST}.partial/rowcounts.txt"
done

# ATOMIC PUBLICATION. The backup is written to `<ts>.partial` and renamed only
# once every file is in place. A crash mid-backup therefore leaves a `.partial`
# directory that the restore script ignores, rather than a half-written backup
# that looks exactly like a complete one — which is the only kind of backup
# worse than none.
mv "${DEST}.partial" "$DEST"
log "base backup complete: ${DEST}"

# --- retention ---------------------------------------------------------------
# Bases first, then WAL. In that order, deliberately: WAL is pruned relative to
# the OLDEST SURVIVING base, so pruning bases first can only ever make the WAL
# cut more conservative. The reverse order can delete WAL a surviving base still
# needs.
log "pruning base backups older than ${RETAIN_DAYS} days"
find "$BASE_DIR" -mindepth 1 -maxdepth 1 -type d -mtime "+${RETAIN_DAYS}" -print -exec rm -rf {} +
# `.partial` leftovers from a crashed run are never useful.
find "$BASE_DIR" -mindepth 1 -maxdepth 1 -type d -name '*.partial' -mtime +1 -print -exec rm -rf {} +

OLDEST="$(find "$BASE_DIR" -mindepth 1 -maxdepth 1 -type d -not -name '*.partial' | sort | head -n1)"
if [ -n "$OLDEST" ] && [ -f "${OLDEST}/START_WAL" ]; then
	CUTOFF="$(cat "${OLDEST}/START_WAL")"
	log "pruning WAL older than ${CUTOFF} (needed by ${OLDEST})"
	# pg_archivecleanup deletes only segments that sort BEFORE the cutoff, which
	# is exactly "no surviving backup can still need this".
	pg_archivecleanup "$WAL_DIR" "$CUTOFF"
else
	# No surviving base means every WAL segment is potentially the only thing
	# standing between us and total loss. Keep all of it and say so.
	log "WARNING: no base backup with a START_WAL marker; retaining ALL WAL"
fi

log "done. bases=$(find "$BASE_DIR" -mindepth 1 -maxdepth 1 -type d -not -name '*.partial' | wc -l) wal=$(find "$WAL_DIR" -type f | wc -l)"
