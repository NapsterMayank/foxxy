#!/usr/bin/env bash
# =============================================================================
# PROOF THAT THE RESTORE DRILL WORKS — and, more importantly, proof that it can
# FAIL.
#
#     ./drill-selftest.sh
#
# =============================================================================
# WHY THIS EXISTS.
#
# The drill is the thing that turns "we have backups" into "we can restore". But
# a drill is itself a piece of enforcement, and this repository has now found
# five separate pieces of enforcement that looked installed and enforced nothing
# — an ESLint rule matching zero files, a rate limiter hooked where no actor
# exists, a metrics sink wired to a no-op, a test harness applying one migration
# of nine, and a settings override that was a silent no-op.
#
# A restore drill that always passes is the same defect with a much larger blast
# radius, because it is believed at exactly the moment it matters most.
#
# So this script runs the drill TWICE against a scratch stack:
#
#   POSITIVE  a real backup of a database with known contents, restored and
#             verified. Must PASS.
#   NEGATIVE  the same backup with the recorded expectation altered so the
#             restored counts no longer match. Must FAIL.
#
# If the negative case passes, the drill is decoration and this script says so.
#
# =============================================================================
# IT NEVER TOUCHES DEVELOPMENT OR PRODUCTION.
#
# Every volume and container name below is prefixed `foxxy_selftest_` /
# `foxxy-selftest-`. It does not read, write, mount or reference
# `foxxy_postgres_data` (the imported corpus) or `foxxy_prod_*`. The source
# database is created by this script, populated by this script, and destroyed by
# this script.
# =============================================================================
set -euo pipefail

# Git Bash / MSYS rewrites any argument that looks like a Unix absolute path
# into a Windows one before exec — so `docker exec c chmod +x /tmp/x.sh` becomes
# `C:/Users/.../tmp/x.sh` INSIDE THE CONTAINER, which does not exist. Unset on
# Linux and macOS, where it is simply an unused variable.
export MSYS_NO_PATHCONV=1

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly IMAGE="${IMAGE:-pgvector/pgvector:pg16}"

readonly SRC_CONTAINER="foxxy-selftest-src"
readonly SRC_VOLUME="foxxy_selftest_src_data"
readonly BACKUP_VOLUME="foxxy_selftest_backup"

# Known contents. The drill must reproduce these EXACTLY.
readonly N_CHAPTERS=137
readonly N_CHUNKS=468
readonly N_QUESTIONS=274

log() { echo "[$(date -u +%FT%TZ)] selftest: $*"; }
banner() { echo; echo "############################################################"; echo "#  $*"; echo "############################################################"; echo; }

teardown() {
	log "tearing down scratch stack"
	docker rm -f "$SRC_CONTAINER" >/dev/null 2>&1 || true
	docker volume rm -f "$SRC_VOLUME" >/dev/null 2>&1 || true
	docker volume rm -f "$BACKUP_VOLUME" >/dev/null 2>&1 || true
	# Any drill instance left behind by a FAILING drill (which deliberately does
	# not clean up after itself, so it can be inspected).
	docker ps -aq --filter "name=foxxy-drill-" | while read -r id; do
		[ -n "$id" ] && docker rm -f "$id" >/dev/null 2>&1 || true
	done
	docker volume ls -q --filter "name=foxxy_drill_" | while read -r vol; do
		[ -n "$vol" ] && docker volume rm -f "$vol" >/dev/null 2>&1 || true
	done
}
trap teardown EXIT

banner "RESTORE-DRILL SELF-TEST"

# --- 0. clean slate -----------------------------------------------------------
teardown

# --- 1. scratch backup volume, owned by uid 999 -------------------------------
docker volume create "$BACKUP_VOLUME" >/dev/null
docker volume create "$SRC_VOLUME" >/dev/null
docker run --rm -v "${BACKUP_VOLUME}:/backup" alpine:3.20 \
	sh -c 'mkdir -p /backup/wal /backup/base && chown -R 999:999 /backup' >/dev/null
log "scratch backup volume prepared"

# --- 2. a source database WITH WAL ARCHIVING ---------------------------------
# The archiving settings are the same ones compose.prod.yml passes to the
# production postgres, so what is proven here is the production configuration
# and not a simplified stand-in.
log "starting scratch source postgres (archive_mode=on)"
docker run -d --name "$SRC_CONTAINER" \
	-v "${SRC_VOLUME}:/var/lib/postgresql/data" \
	-v "${BACKUP_VOLUME}:/backup" \
	-e POSTGRES_PASSWORD=selftest \
	-e POSTGRES_DB=foxxy \
	"$IMAGE" \
	postgres \
	-c wal_level=replica \
	-c archive_mode=on \
	-c "archive_command=test ! -f /backup/wal/%f && cp %p /backup/wal/%f" \
	-c archive_timeout=60 \
	-c max_wal_senders=3 >/dev/null

for _ in $(seq 1 60); do
	docker exec "$SRC_CONTAINER" pg_isready -q -U postgres -d foxxy 2>/dev/null && break
	sleep 2
done
docker exec "$SRC_CONTAINER" pg_isready -q -U postgres -d foxxy || {
	docker logs --tail 40 "$SRC_CONTAINER" >&2
	echo "SELFTEST ERROR: scratch source postgres never became ready" >&2
	exit 1
}
log "scratch source is up"

# --- 3. known contents --------------------------------------------------------
# `-i` is load-bearing. Without it stdin is not attached to the container, psql
# reads nothing, exits 0, and the seed SILENTLY does not happen — leaving a
# self-test that backs up an empty database and reports success. Found the hard
# way on the first run of this script.
docker exec -i -e PGPASSWORD=selftest "$SRC_CONTAINER" psql -U postgres -d foxxy -v ON_ERROR_STOP=1 -q <<SQL
create table chapters   (id int primary key, title text not null);
create table rag_chunks  (id int primary key, content text not null);
create table questions   (id int primary key, body text not null);
insert into chapters   select g, 'chapter ' || g from generate_series(1, ${N_CHAPTERS}) g;
insert into rag_chunks select g, 'chunk content ' || g from generate_series(1, ${N_CHUNKS}) g;
insert into questions  select g, 'question ' || g from generate_series(1, ${N_QUESTIONS}) g;
SQL
log "seeded: chapters=${N_CHAPTERS} rag_chunks=${N_CHUNKS} questions=${N_QUESTIONS}"

# --- 4. the real backup script, run against it --------------------------------
# Fed on stdin rather than `docker cp`'d: the redirect is performed by the host
# shell, so no host path is ever handed to Docker and the script is portable
# across Git Bash, macOS and Linux without path translation.
docker exec -i \
	-e PGUSER=postgres -e PGPASSWORD=selftest -e PGDATABASE=foxxy \
	-e BACKUP_DIR=/backup -e RETAIN_DAYS=14 \
	-u 999:999 \
	"$SRC_CONTAINER" bash -s <"${SCRIPT_DIR}/full-backup.sh"
log "base backup taken by the production backup script"

# --- 5. write MORE data and force a WAL switch --------------------------------
# So the archive has segments after the base backup and the restore genuinely
# has to replay them. Without this step the drill would only prove that a tar
# file extracts.
docker exec -e PGPASSWORD=selftest "$SRC_CONTAINER" psql -U postgres -d foxxy -v ON_ERROR_STOP=1 -q -c \
	"insert into chapters select g, 'post-backup ' || g from generate_series(1000, 1010) g; select pg_switch_wal();" >/dev/null
log "post-backup writes made and WAL switched"
# HONESTLY STATED: these rows are NOT part of what the drill asserts. The
# expectation in `rowcounts.txt` was recorded AT BACKUP TIME, so by construction
# it can never contain anything written afterwards — a drill can verify "the
# backup restores to the state it recorded", and that is the claim it makes.
#
# Recovering PAST the base backup, to an arbitrary instant, is a different
# operation with a different assertion: `restore.sh --target-time`. The number
# of WAL segments restore.sh reports fetching from the archive is what
# distinguishes the two, and it prints that number on every restore.

# =============================================================================
# POSITIVE CASE — the drill must PASS
# =============================================================================
banner "CASE 1 (positive): the drill must PASS"
if "${SCRIPT_DIR}/restore-drill.sh" --backup-volume "$BACKUP_VOLUME" --image "$IMAGE"; then
	log "CASE 1 PASSED as required"
else
	banner "SELF-TEST FAILED: the drill could not verify a KNOWN-GOOD backup"
	exit 1
fi

# =============================================================================
# NEGATIVE CASE — the drill must FAIL
#
# The recorded expectation is altered so that the restored database no longer
# matches it. This is exactly the shape of the real failure the drill exists to
# catch: a backup that restores into a database missing rows.
# =============================================================================
banner "CASE 2 (negative): the drill must FAIL on a deliberate mismatch"
docker run --rm -v "${BACKUP_VOLUME}:/backup" "$IMAGE" bash -c '
set -euo pipefail
dir=$(ls -1d /backup/base/*/ | grep -v "\.partial" | sort | tail -n1)
sed -i "s/^chapters .*/chapters 999999/" "${dir}rowcounts.txt"
echo "  tampered expectation: $(grep "^chapters " "${dir}rowcounts.txt")"
'

if "${SCRIPT_DIR}/restore-drill.sh" --backup-volume "$BACKUP_VOLUME" --image "$IMAGE"; then
	banner "SELF-TEST FAILED: the drill PASSED a backup that does not match its own expectation"
	echo "The drill is decoration. Do not trust it." >&2
	exit 1
else
	log "CASE 2 FAILED as required — the drill detects a mismatch"
fi

banner "RESTORE-DRILL SELF-TEST: PASS (drill verifies, and drill can fail)"
