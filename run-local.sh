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
IMAGE="${IMAGE:-cdp-dbgate}"
PROXY_URL="${PROXY_URL:-http://localhost:8000}"
MONGO_URL="${MONGO_URL:-mongodb://host.docker.internal:27017/${SERVICE}?tls=false}"

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

docker run -d --name "$NAME" \
  -p "8085:8085" \
  --add-host=host.docker.internal:host-gateway \
  -e PORT=8085 \
  -e TOKEN="$TOKEN" \
  -e SERVICE="$SERVICE" \
  -e ENVIRONMENT="$ENVIRONMENT" \
  -e URL_mongo="$MONGO_URL" \
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
  -d "{\"id\":\"${TOKEN}\",\"target\":\"localhost\",\"image\":\"cdp-dbgate\"}" \
  "${PROXY_URL}/admin/register" >/dev/null; then
  echo "registered ${TOKEN} with ${PROXY_URL}"
else
  echo "proxy register failed (${PROXY_URL}). Start cdp-webshell-proxy, then re-run this script." >&2
fi
