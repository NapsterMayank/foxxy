#!/usr/bin/env bash
# =============================================================================
# RESTORE — rebuild a Postgres instance from a base backup plus archived WAL.
#
#     ./restore.sh --target-volume foxxy_restore_20260810 --container foxxy-restore
#     ./restore.sh --backup 20260810T023000Z --target-time '2026-08-10 14:07:00+00'
#
# Run from the HOST (it needs Docker), not from inside a container. See
# docs/runbooks/backup-restore.md for the numbered procedure this implements.
#
# =============================================================================
# IT NEVER TOUCHES THE SOURCE. Three separate guards, because a restore script
# is run by a frightened person at 3am and the worst possible outcome is that it
# damages the thing it is recovering:
#
#   1. The backup volume is mounted READ-ONLY (`:ro`) everywhere it appears.
#   2. `archive_mode = off` is forced into the restored instance's config. A
#      restored instance inherits the original's archive settings; left alone it
#      would begin writing ITS OWN timeline's WAL into the production archive
#      directory, which corrupts the archive that every other backup depends on.
#      This is the single most dangerous default in the whole procedure.
#   3. The script REFUSES to write to a target volume whose name is not
#      distinct from the live one.
#
# =============================================================================
# POINT-IN-TIME RECOVERY.
#
# With no --target-time, recovery replays every archived WAL segment and then
# promotes: "as recent as the archive allows". With --target-time it stops at
# that instant — the case that matters for a bad migration or a mistaken DELETE,
# where the most recent data is precisely the data you do not want.
# =============================================================================
set -euo pipefail

# Git Bash / MSYS rewrites arguments that look like Unix absolute paths into
# Windows paths before exec, which silently corrupts every in-container path
# passed to `docker exec` / `docker run`. Unset on Linux and macOS.
export MSYS_NO_PATHCONV=1

BACKUP_VOLUME="foxxy_prod_backup_data"
BACKUP_ID="latest"
TARGET_VOLUME=""
CONTAINER_NAME="foxxy-restore"
TARGET_TIME=""
IMAGE="pgvector/pgvector:pg16"
PUBLISH_PORT=""
RESTORE_PASSWORD="restore-only-$(date +%s)"

usage() {
	cat >&2 <<'EOF'
usage: restore.sh --target-volume <name> [options]

  --target-volume <name>   REQUIRED. Docker volume to restore INTO. Created if
                           absent; its contents are erased.
  --backup-volume <name>   Volume holding base/ and wal/. Default:
                           foxxy_prod_backup_data
  --backup <id|latest>     Base backup directory name. Default: latest
  --container <name>       Name for the restored instance. Default: foxxy-restore
  --target-time <ts>       PITR stop point, e.g. '2026-08-10 14:07:00+00'
  --publish <port>         Publish 5432 on this host port (debugging only)
  --image <ref>            Postgres image. Must match the source MAJOR version.
EOF
	exit 64
}

while [ $# -gt 0 ]; do
	case "$1" in
	--target-volume) TARGET_VOLUME="$2"; shift 2 ;;
	--backup-volume) BACKUP_VOLUME="$2"; shift 2 ;;
	--backup) BACKUP_ID="$2"; shift 2 ;;
	--container) CONTAINER_NAME="$2"; shift 2 ;;
	--target-time) TARGET_TIME="$2"; shift 2 ;;
	--publish) PUBLISH_PORT="$2"; shift 2 ;;
	--image) IMAGE="$2"; shift 2 ;;
	-h | --help) usage ;;
	*) echo "restore.sh: unknown option '$1'" >&2; usage ;;
	esac
done

log() { echo "[$(date -u +%FT%TZ)] restore: $*"; }
die() { echo "[$(date -u +%FT%TZ)] restore: FATAL: $*" >&2; exit 1; }

[ -n "$TARGET_VOLUME" ] || { echo "restore.sh: --target-volume is required" >&2; usage; }

# Guard 3. The live data volume is never a restore target, whatever anyone
# types. Restoring over a live volume is not a recovery, it is the second half
# of the incident.
case "$TARGET_VOLUME" in
foxxy_prod_postgres_data | foxxy_postgres_data)
	die "refusing to restore INTO the live data volume '${TARGET_VOLUME}'. Restore to a NEW volume, verify it, then swap."
	;;
esac
[ "$TARGET_VOLUME" != "$BACKUP_VOLUME" ] || die "target volume and backup volume are the same"

docker volume inspect "$BACKUP_VOLUME" >/dev/null 2>&1 || die "backup volume '${BACKUP_VOLUME}' does not exist"

# --- 1. choose the base backup ----------------------------------------------
# `.partial` directories are excluded: full-backup.sh publishes atomically by
# renaming, so a `.partial` is by definition an interrupted backup.
if [ "$BACKUP_ID" = "latest" ]; then
	BACKUP_ID="$(docker run --rm -v "${BACKUP_VOLUME}:/backup:ro" "$IMAGE" \
		bash -c "ls -1 /backup/base 2>/dev/null | grep -v '\.partial$' | sort | tail -n1")"
	[ -n "$BACKUP_ID" ] || die "no completed base backup found in ${BACKUP_VOLUME}:/backup/base"
fi
log "restoring base backup '${BACKUP_ID}' from volume '${BACKUP_VOLUME}'"

docker run --rm -v "${BACKUP_VOLUME}:/backup:ro" "$IMAGE" \
	test -f "/backup/base/${BACKUP_ID}/base.tar.gz" ||
	die "base backup '${BACKUP_ID}' has no base.tar.gz — it is not a usable backup"

# --- 2. prepare the target volume -------------------------------------------
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
docker volume rm -f "$TARGET_VOLUME" >/dev/null 2>&1 || true
docker volume create "$TARGET_VOLUME" >/dev/null
log "target volume '${TARGET_VOLUME}' created"

# --- 3. extract, and write the recovery configuration ------------------------
# The inner script arrives on stdin so that nothing here needs three levels of
# shell quoting — which is where restore scripts traditionally acquire the bug
# that is only discovered during an incident.
docker run --rm -i \
	-v "${BACKUP_VOLUME}:/backup:ro" \
	-v "${TARGET_VOLUME}:/pgdata" \
	-e "BACKUP_ID=${BACKUP_ID}" \
	-e "TARGET_TIME=${TARGET_TIME}" \
	"$IMAGE" bash -s <<'INNER'
set -euo pipefail
echo "  extracting base.tar.gz"
tar xzf "/backup/base/${BACKUP_ID}/base.tar.gz" -C /pgdata

echo "  extracting pg_wal.tar.gz"
mkdir -p /pgdata/pg_wal
if [ -f "/backup/base/${BACKUP_ID}/pg_wal.tar.gz" ]; then
  tar xzf "/backup/base/${BACKUP_ID}/pg_wal.tar.gz" -C /pgdata/pg_wal
fi

echo "  writing recovery configuration"
# Appended to whatever the base backup carried, so the LAST occurrence wins —
# which is why archive_mode=off is written here and not merely assumed.
cat >> /pgdata/postgresql.auto.conf <<CONF

# ---- written by docker/backup/restore.sh ----
restore_command = 'cp /backup/wal/%f %p'
recovery_target_action = 'promote'
# NON-NEGOTIABLE. A restored instance inherits the source's archive settings.
# Left on, it writes its own divergent timeline into the production WAL archive
# and destroys the chain every other backup depends on.
archive_mode = off
# The restored instance is a copy. It must not believe it is anybody's primary.
hot_standby = on
CONF

if [ -n "${TARGET_TIME}" ]; then
  echo "recovery_target_time = '${TARGET_TIME}'" >> /pgdata/postgresql.auto.conf
  echo "  point-in-time target: ${TARGET_TIME}"
fi

# Postgres 12+ : the presence of this file is what puts the instance into
# archive recovery.
touch /pgdata/recovery.signal

chown -R 999:999 /pgdata
chmod 700 /pgdata
echo "  prepared"
INNER

# --- 4. start the restored instance ------------------------------------------
PUBLISH_ARGS=()
[ -n "$PUBLISH_PORT" ] && PUBLISH_ARGS=(-p "${PUBLISH_PORT}:5432")

docker run -d \
	--name "$CONTAINER_NAME" \
	-v "${TARGET_VOLUME}:/var/lib/postgresql/data" \
	-v "${BACKUP_VOLUME}:/backup:ro" \
	-e "POSTGRES_PASSWORD=${RESTORE_PASSWORD}" \
	"${PUBLISH_ARGS[@]}" \
	"$IMAGE" >/dev/null
log "instance '${CONTAINER_NAME}' starting; replaying WAL"

# --- 5. wait for recovery to finish ------------------------------------------
# `pg_isready` alone is not enough: an instance still in recovery answers it.
# The condition that matters is `pg_is_in_recovery() = false`, i.e. promoted.
for attempt in $(seq 1 90); do
	if docker exec "$CONTAINER_NAME" pg_isready -q 2>/dev/null; then
		in_recovery="$(docker exec "$CONTAINER_NAME" psql -U postgres -Atqc 'select pg_is_in_recovery()' 2>/dev/null || echo 'error')"
		if [ "$in_recovery" = 'f' ]; then
			log "recovery complete and promoted after ${attempt} check(s)"
			# EVIDENCE THAT THE ARCHIVE WAS ACTUALLY USED.
			#
			# A base backup taken with `--wal-method=stream` carries enough WAL
			# inside it to be self-consistent on its own, so an instance can
			# recover and promote WITHOUT ever calling restore_command. That is a
			# perfectly good restore of last night's backup — and it is NOT
			# point-in-time recovery, which is the thing §7 actually asks for.
			#
			# The two are indistinguishable from row counts alone, so the count
			# is printed: zero restored segments means the archive chain has not
			# been exercised, whatever else passed.
			restored_segments="$(docker logs "$CONTAINER_NAME" 2>&1 | grep -c 'restored log file' || true)"
			log "WAL segments fetched from the archive during recovery: ${restored_segments}"
			if [ "$restored_segments" = '0' ]; then
				log "NOTE: recovery used only the WAL bundled in the base backup. The"
				log "      archive chain was NOT exercised by this restore. To exercise"
				log "      it, restore with --target-time after the backup completed."
			fi
			echo "$CONTAINER_NAME"
			exit 0
		fi
	fi
	sleep 2
done

log "instance did not finish recovery within 180s. Logs:"
docker logs --tail 60 "$CONTAINER_NAME" >&2 || true
die "restore did not complete"
