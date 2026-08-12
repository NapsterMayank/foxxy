#!/usr/bin/env bash
# =============================================================================
# THE RESTORE DRILL. 04-RESILIENCE-PLAN.md §7:
#
#   "A backup that has never been restored is not a backup. The restore drill is
#    a calendar item, and it is the single most important operational practice
#    in this document."
#
#     ./restore-drill.sh                       # latest backup, prod volume
#     ./restore-drill.sh --backup-volume X --backup 20260810T023000Z
#
# =============================================================================
# WHAT MAKES THIS A DRILL AND NOT A SMOKE TEST.
#
# It performs a REAL restore into a scratch database and then compares the
# restored row counts against `rowcounts.txt`, which full-backup.sh recorded
# from the LIVE database at the moment the backup was taken.
#
# Three ways a restore can be broken that "the container started" would not
# catch, and this does:
#
#   - the base backup extracts but the WAL chain is incomplete, so recovery
#     stops early and the database is missing the last N hours;
#   - a table exists but is empty, because the backup ran against the wrong
#     database or a schema that was mid-migration;
#   - the backup is of a database that was ALREADY empty — which every
#     "compare against live" drill passes, because both sides are zero.
#
# =============================================================================
# IT FAILS LOUDLY. Non-zero exit, a FAIL banner, and the scratch instance is
# LEFT RUNNING on failure so it can be inspected. A drill that cleans up its own
# evidence is a drill that can only tell you "no".
#
# IT NEVER TOUCHES THE LIVE DATABASE. It reads the backup volume read-only and
# writes only to a scratch volume whose name carries this run's timestamp.
# =============================================================================
set -euo pipefail

# See docker/backup/restore.sh — MSYS path rewriting corrupts in-container
# paths. Unset on Linux and macOS.
export MSYS_NO_PATHCONV=1

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

BACKUP_VOLUME="foxxy_prod_backup_data"
BACKUP_ID="latest"
IMAGE="pgvector/pgvector:pg16"
KEEP=0

usage() {
	cat >&2 <<'EOF'
usage: restore-drill.sh [options]

  --backup-volume <name>   Default: foxxy_prod_backup_data
  --backup <id|latest>     Default: latest
  --image <ref>            Default: pgvector/pgvector:pg16
  --keep                   Leave the scratch instance running after a PASS
EOF
	exit 64
}

while [ $# -gt 0 ]; do
	case "$1" in
	--backup-volume) BACKUP_VOLUME="$2"; shift 2 ;;
	--backup) BACKUP_ID="$2"; shift 2 ;;
	--image) IMAGE="$2"; shift 2 ;;
	--keep) KEEP=1; shift ;;
	-h | --help) usage ;;
	*) echo "restore-drill.sh: unknown option '$1'" >&2; usage ;;
	esac
done

readonly RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
readonly SCRATCH_VOLUME="foxxy_drill_${RUN_ID}"
readonly SCRATCH_CONTAINER="foxxy-drill-${RUN_ID}"

log() { echo "[$(date -u +%FT%TZ)] drill: $*"; }
banner() { echo; echo "============================================================"; echo "  $*"; echo "============================================================"; echo; }

cleanup_scratch() {
	docker rm -f "$SCRATCH_CONTAINER" >/dev/null 2>&1 || true
	docker volume rm -f "$SCRATCH_VOLUME" >/dev/null 2>&1 || true
}

fail() {
	banner "RESTORE DRILL: FAIL — $*"
	echo "The scratch instance '${SCRATCH_CONTAINER}' has been LEFT RUNNING for" >&2
	echo "inspection. Clean it up with:" >&2
	echo "    docker rm -f ${SCRATCH_CONTAINER} && docker volume rm ${SCRATCH_VOLUME}" >&2
	echo >&2
	echo "Runbook: docs/runbooks/backup-restore.md" >&2
	exit 1
}

banner "RESTORE DRILL ${RUN_ID}"
log "backup volume: ${BACKUP_VOLUME}"
log "backup id:     ${BACKUP_ID}"
log "scratch:       ${SCRATCH_CONTAINER} / ${SCRATCH_VOLUME}"

# --- 1. restore ---------------------------------------------------------------
if ! "${SCRIPT_DIR}/restore.sh" \
	--backup-volume "$BACKUP_VOLUME" \
	--backup "$BACKUP_ID" \
	--target-volume "$SCRATCH_VOLUME" \
	--container "$SCRATCH_CONTAINER" \
	--image "$IMAGE"; then
	fail "the restore itself did not complete"
fi

# --- 2. resolve which backup was actually used -------------------------------
if [ "$BACKUP_ID" = "latest" ]; then
	BACKUP_ID="$(docker run --rm -v "${BACKUP_VOLUME}:/backup:ro" "$IMAGE" \
		bash -c "ls -1 /backup/base | grep -v '\.partial$' | sort | tail -n1")"
fi

EXPECTED="$(docker run --rm -v "${BACKUP_VOLUME}:/backup:ro" "$IMAGE" \
	bash -c "cat /backup/base/${BACKUP_ID}/rowcounts.txt 2>/dev/null || true")"

# A backup with no recorded expectation cannot be verified, and an unverifiable
# backup must not be reported as a PASS. This is the difference between a drill
# and a ritual.
[ -n "$EXPECTED" ] || fail "backup '${BACKUP_ID}' carries no rowcounts.txt — nothing to verify against"

# WHICH DATABASE TO VERIFY. Recorded by full-backup.sh beside the counts.
#
# This is not a detail. Connecting to the restored cluster's default database
# (`postgres`) instead of the application's finds no tables, so every "this
# table did not exist" expectation matches trivially and the drill reports a
# row of `ok`s for a database it never looked at. That is precisely what
# happened on the first run of the self-test, and it is why the database name
# is read from the backup rather than assumed.
VERIFY_DB="$(docker run --rm -v "${BACKUP_VOLUME}:/backup:ro" "$IMAGE" \
	bash -c "cat /backup/base/${BACKUP_ID}/DATABASE 2>/dev/null || true")"
[ -n "$VERIFY_DB" ] || fail "backup '${BACKUP_ID}' does not record which database it counted (no DATABASE file). Re-take the backup with the current full-backup.sh."
log "verifying against database '${VERIFY_DB}'"

# And prove that database is actually there before believing anything it says.
if [ "$(docker exec "$SCRATCH_CONTAINER" psql -U postgres -Atqc \
	"select count(*) from pg_database where datname = '${VERIFY_DB}'")" != '1' ]; then
	fail "the restored cluster has no database named '${VERIFY_DB}'"
fi

# --- 3. compare -------------------------------------------------------------
log "comparing restored row counts against the counts recorded at backup time"
printf '\n  %-28s %12s %12s   %s\n' 'TABLE' 'EXPECTED' 'RESTORED' 'RESULT'
printf '  %-28s %12s %12s   %s\n' '----------------------------' '------------' '------------' '------'

mismatches=0
checked=0
nonempty=0

while read -r table expected; do
	[ -n "${table:-}" ] || continue

	if [ "$expected" = "-1" ]; then
		# The table did not exist when the backup was taken. Assert it still does
		# not: a restore that INVENTS a table is as wrong as one that loses one,
		# and it is the signature of restoring the wrong backup.
		exists="$(docker exec "$SCRATCH_CONTAINER" psql -U postgres -d "$VERIFY_DB" -Atqc \
			"select to_regclass('public.${table}') is not null" 2>/dev/null || echo 'error')"
		if [ "$exists" = 'f' ]; then
			printf '  %-28s %12s %12s   %s\n' "$table" 'absent' 'absent' 'ok'
		else
			printf '  %-28s %12s %12s   %s\n' "$table" 'absent' "$exists" 'MISMATCH'
			mismatches=$((mismatches + 1))
		fi
		checked=$((checked + 1))
		continue
	fi

	actual="$(docker exec "$SCRATCH_CONTAINER" psql -U postgres -d "$VERIFY_DB" -Atqc \
		"select count(*) from public.\"${table}\"" 2>/dev/null || echo 'ERROR')"

	if [ "$actual" = "$expected" ]; then
		printf '  %-28s %12s %12s   %s\n' "$table" "$expected" "$actual" 'ok'
	else
		printf '  %-28s %12s %12s   %s\n' "$table" "$expected" "$actual" 'MISMATCH'
		mismatches=$((mismatches + 1))
	fi
	[ "$expected" -gt 0 ] 2>/dev/null && nonempty=$((nonempty + 1))
	checked=$((checked + 1))
done <<<"$EXPECTED"

echo

# --- 4. verdict --------------------------------------------------------------
[ "$checked" -gt 0 ] || fail "no tables were checked — the comparison did nothing"

# THE VACUITY GUARD. Every count matching zero is not evidence of a working
# backup; it is evidence of a working `SELECT count(*)`. If nothing that was
# expected to hold rows held rows, this drill measured nothing and says so.
if [ "$nonempty" -eq 0 ]; then
	fail "every expected count was zero — this drill would pass against an empty backup, so it proves nothing"
fi

if [ "$mismatches" -gt 0 ]; then
	fail "${mismatches} of ${checked} tables did not match"
fi

# --- 5. a real query, not just a count ---------------------------------------
# A count can be satisfied by a table full of unreadable rows. One real read
# through the restored indexes proves the data is usable, not merely present.
if [ "$(docker exec "$SCRATCH_CONTAINER" psql -U postgres -d "$VERIFY_DB" -Atqc \
	"select to_regclass('public.rag_chunks') is not null")" = 't' ]; then
	sample="$(docker exec "$SCRATCH_CONTAINER" psql -U postgres -d "$VERIFY_DB" -Atqc \
		"select count(*) from public.rag_chunks where content is not null and length(content) > 0")"
	log "readable rag_chunks with content: ${sample}"
fi

log "verified ${checked} tables, ${nonempty} of them non-empty, 0 mismatches"

if [ "$KEEP" -eq 1 ]; then
	log "--keep: leaving ${SCRATCH_CONTAINER} running"
else
	log "removing scratch instance"
	cleanup_scratch
fi

banner "RESTORE DRILL: PASS (backup ${BACKUP_ID})"
