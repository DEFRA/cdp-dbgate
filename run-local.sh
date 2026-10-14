#!/bin/bash
set -euo pipefail

# Run cdp-dbgate on the laptop against local Mongo, then register the Portal token
# with the webshell proxy so the spinner can finish.
#
# Usage:
#   ./run-local.sh <token-or-portal-url> [service]
#
# Example:
#   ./run-local.sh 9543e769eb2f3c4c5aec43eb04be6f4fe60362b73d6fb37f806a85cb810e8cfd
#   ./run-local.sh 'http://cdp.127.0.0.1.sslip.io:3000/services/cdp-portal-backend/terminal/infra-dev/<token>?tool=dbgate'

TOKEN="${1:-}"
SERVICE="${2:-cdp-portal-backend}"
ENVIRONMENT="${ENVIRONMENT:-infra-dev}"
IMAGE="${IMAGE:-cdp-dbgate:local}"
PROXY_URL="${PROXY_URL:-http://localhost:8000}"
DBGATE_ENGINE="${DBGATE_ENGINE:-mongo}"
MONGO_URL="${MONGO_URL:-mongodb://host.docker.internal:27017/${SERVICE}?tls=false}"
REDIS_HOST="${REDIS_HOST:-host.docker.internal}"
REDIS_PORT="${REDIS_PORT:-6379}"
REDIS_TLS="${REDIS_TLS:-false}"
AUDIT_UPLOAD_URL="${AUDIT_UPLOAD_URL:-}"
# Lambda sets USER_ID in ECS. For local / stubs, default so audit lines show a user.
USER_ID="${USER_ID:-local-user}"
# Webshell-proxy owner check (USER_AUTH_ENABLED). Must match Portal credentials.id /
# cdpShellAuth cookie oid. Default is journey-tests "Admin User".
OWNER_ID="${OWNER_ID:-90552794-0613-4023-819a-512aa9d40023}"

if [ -z "$TOKEN" ]; then
  echo "usage: $0 <token-or-portal-url> [service]" >&2
  exit 1
fi

# Accept the Portal browser URL as well as the bare token.
if [[ "$TOKEN" == *"/terminal/"* ]]; then
  TOKEN="$(printf '%s' "$TOKEN" | sed -E 's#.*/terminal/[^/]+/([^/?]+).*#\1#')"
fi

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "image ${IMAGE} not found, building"
  docker build -t "$IMAGE" "$(cd "$(dirname "$0")" && pwd)"
fi

NAME="cdp-dbgate-local"
docker rm -f "$NAME" >/dev/null 2>&1 || true

env_args=(
  -e PORT=8085
  -e TOKEN="$TOKEN"
  -e SERVICE="$SERVICE"
  -e ENVIRONMENT="$ENVIRONMENT"
  -e USER_ID="$USER_ID"
  -e DBGATE_ENGINE="$DBGATE_ENGINE"
  -e AUDIT_UPLOAD_URL="$AUDIT_UPLOAD_URL"
)

case "$DBGATE_ENGINE" in
  mongo)
    env_args+=(-e URL_mongo="$MONGO_URL")
    ;;
  redis)
    env_args+=(
      -e REDIS_HOST="$REDIS_HOST"
      -e REDIS_PORT="$REDIS_PORT"
      -e REDIS_TLS="$REDIS_TLS"
      # Bare -e copies the value from this shell (if set) and keeps the password out of the docker command line.
      -e REDIS_USERNAME
      -e REDIS_PASSWORD
    )
    ;;
  *)
    echo "unsupported DBGATE_ENGINE '${DBGATE_ENGINE}', expected mongo or redis" >&2
    exit 1
    ;;
esac

docker run -d --name "$NAME" \
  -p "8085:8085" \
  --add-host=host.docker.internal:host-gateway \
  "${env_args[@]}" \
  "$IMAGE"

echo "waiting for http://localhost:8085/${TOKEN}"
ready=0
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null --max-time 2 "http://localhost:8085/${TOKEN}" 2>/dev/null; then
    ready=1
    break
  fi
  if ! docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null | grep -q true; then
    echo "container ${NAME} exited before it was ready" >&2
    docker logs "$NAME" >&2 || true
    exit 1
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "dbgate did not answer on port 8085" >&2
  exit 1
fi

if curl -fsS -u testuser:testpass -H 'Content-type: application/json' \
  -d "{\"id\":\"${TOKEN}\",\"owner_id\":\"${OWNER_ID}\",\"target\":\"localhost\",\"image\":\"cdp-dbgate\"}" \
  "${PROXY_URL}/admin/register" >/dev/null; then
  echo "registered ${TOKEN} with ${PROXY_URL} (owner_id=${OWNER_ID})"
else
  echo "proxy register failed (${PROXY_URL}). Start cdp-webshell-proxy, then re-run this script." >&2
fi
