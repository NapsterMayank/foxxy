#!/usr/bin/env bash
# =============================================================================
# THE ONLY DEPLOYMENT ENTRY POINT AN APPLICATION PIPELINE HAS.
#
#     ./deploy-app.sh backend|frontend|website [image-tag]
#
# 06-FRONTEND-SEPARATION-PLAN.md: "Marketing deployments must never restart or
# rewrite the product, backend, or proxy configuration", and "Marketing
# deployment credentials cannot restart, recreate, or inspect product
# containers and volumes."
#
# =============================================================================
# WHAT MAKES THAT TRUE HERE RATHER THAN ASPIRATIONAL.
#
# 1. The service list is an ALLOW-LIST keyed by app name. There is no argument
#    that reaches `caddy`, `postgres`, `valkey` or `backup` — not a flag, not a
#    service name, not a pass-through. A marketing deploy can restart `website`
#    and nothing else, because `website` is the only thing its case branch
#    names.
#
# 2. `--no-deps`. Without it, `docker compose up -d website` also recreates
#    everything `website` depends on. That is precisely the mechanism by which a
#    marketing deploy takes the product down, and it is the default.
#
# 3. Migrations are NOT here. A backend deploy that could also migrate is a
#    backend deploy where a schema change happens by accident. Migration is a
#    separate, explicit command — see docs/runbooks/deploy-rollback.md.
#
# 4. The proxy configuration is mounted read-only and is not a service this
#    script will name, so a `caddy reload` is not reachable either.
#
# In a real deployment the enforcement is ALSO credential-scoped: the marketing
# pipeline's SSH key runs a forced command that is this script with the argument
# fixed to `website`. This file is the mechanism; the key is the boundary.
# =============================================================================
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly COMPOSE_FILE="${SCRIPT_DIR}/compose.prod.yml"
readonly ENV_FILE="${SCRIPT_DIR}/.env.prod"

# Named so a future edit that adds one has to think about it.
readonly FORBIDDEN='caddy postgres valkey backup backup-init migrate'

usage() {
	cat >&2 <<'EOF'
usage: deploy-app.sh <backend|frontend|website> [image-tag]

  backend    restarts backend-api, backend-worker, backend-alerts
  frontend   restarts frontend
  website    restarts website

Never touches: caddy, postgres, valkey, backup. Never runs migrations.
EOF
	exit 64
}

[ $# -ge 1 ] || usage
readonly APP="$1"
readonly TAG="${2:-}"

case "$APP" in
backend) SERVICES=(backend-api backend-worker backend-alerts); IMAGE_VAR=BACKEND_IMAGE ;;
frontend) SERVICES=(frontend); IMAGE_VAR=FRONTEND_IMAGE ;;
website) SERVICES=(website); IMAGE_VAR=WEBSITE_IMAGE ;;
*)
	echo "deploy-app.sh: unknown app '${APP}'." >&2
	usage
	;;
esac

# Belt and braces. The case statement above already makes this unreachable; it
# is here so that ADDING a branch that names a forbidden service fails loudly at
# runtime instead of quietly widening the boundary.
for service in "${SERVICES[@]}"; do
	for forbidden in $FORBIDDEN; do
		if [ "$service" = "$forbidden" ]; then
			echo "deploy-app.sh: REFUSED — '${service}' is infrastructure-owned." >&2
			exit 77
		fi
	done
done

[ -f "$ENV_FILE" ] || {
	echo "deploy-app.sh: ${ENV_FILE} not found. Copy .env.prod.example and fill it in." >&2
	exit 78
}

compose() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

if [ -n "$TAG" ]; then
	echo "==> ${IMAGE_VAR}=${TAG}"
	export "${IMAGE_VAR}=${TAG}"
fi

echo "==> pulling ${SERVICES[*]}"
compose pull "${SERVICES[@]}"

# --no-deps: recreate ONLY these containers. See point 2 in the header.
echo "==> recreating ${SERVICES[*]} (--no-deps)"
compose up -d --no-deps "${SERVICES[@]}"

echo "==> post-deploy state"
compose ps "${SERVICES[@]}"

# A deploy that reports success without checking anything is a deploy that
# reports success. For the backend the readiness probe is the check that
# matters, and it is the one the load balancer uses.
if [ "$APP" = "backend" ]; then
	echo "==> waiting for /health/ready"
	for attempt in $(seq 1 30); do
		if compose exec -T backend-api node -e \
			"fetch('http://127.0.0.1:4000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
			echo "==> ready after ${attempt} attempt(s)"
			exit 0
		fi
		sleep 2
	done
	echo "deploy-app.sh: backend never became ready. ROLL BACK — docs/runbooks/deploy-rollback.md" >&2
	exit 1
fi

echo "==> done"
