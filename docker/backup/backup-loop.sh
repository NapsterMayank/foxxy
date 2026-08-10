#!/usr/bin/env bash
# =============================================================================
# The `backup` container's entry point: sleep until BACKUP_AT_UTC, run
# full-backup.sh, repeat.
#
# WHY NOT CRON. A cron daemon in a container needs the container to run as root
# (or a second process supervisor), swallows its own stdout unless every job is
# redirected, and reports a failure by writing mail to a mailbox nobody reads.
# This loop runs as uid 999, logs to stdout where the Docker log driver picks it
# up, and a failed backup is a loud line in `docker compose logs backup`.
#
# WHY THE FAILURE DOES NOT KILL THE CONTAINER. A backup that fails tonight must
# still be attempted tomorrow — an exit here would leave `restart: unless-stopped`
# hot-looping the backup against a database that is down, and would mean one bad
# night silently ends all future backups.
#
# The failure IS surfaced: `backup.failed` is written to metrics_events by the
# alert evaluator's readiness rule (a base backup older than 36 hours pages a
# human — docs/runbooks/incident-response.md).
# =============================================================================
set -uo pipefail

BACKUP_AT_UTC="${BACKUP_AT_UTC:-02:30}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { echo "[$(date -u +%FT%TZ)] backup-loop: $*"; }

running=1
# SIGTERM during `docker compose down` must stop the SLEEP, not be queued behind
# it. Without this the container waits out its stop_grace_period and is killed.
trap 'log "SIGTERM received; stopping after the current step"; running=0' TERM INT

seconds_until_next_run() {
	local target_hour target_minute now_epoch target_epoch
	target_hour="${BACKUP_AT_UTC%%:*}"
	target_minute="${BACKUP_AT_UTC##*:}"
	now_epoch="$(date -u +%s)"
	target_epoch="$(date -u -d "today ${target_hour}:${target_minute}:00" +%s)"
	if [ "$target_epoch" -le "$now_epoch" ]; then
		target_epoch="$(date -u -d "tomorrow ${target_hour}:${target_minute}:00" +%s)"
	fi
	echo $((target_epoch - now_epoch))
}

log "started. nightly base backup at ${BACKUP_AT_UTC} UTC; WAL is archived continuously by postgres"

while [ "$running" -eq 1 ]; do
	wait_for="$(seconds_until_next_run)"
	log "next base backup in ${wait_for}s"
	# Slept in 60-second slices so a SIGTERM is honoured within a minute rather
	# than up to 24 hours later.
	while [ "$wait_for" -gt 0 ] && [ "$running" -eq 1 ]; do
		slice=$((wait_for > 60 ? 60 : wait_for))
		sleep "$slice"
		wait_for=$((wait_for - slice))
	done
	[ "$running" -eq 1 ] || break

	if "${SCRIPT_DIR}/full-backup.sh"; then
		log "base backup succeeded"
	else
		# Loud, and then carry on. See the header.
		log "ERROR: base backup FAILED (exit $?). The next attempt is tomorrow."
	fi
done

log "stopped"
