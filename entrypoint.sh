#!/bin/bash
set -euo pipefail

# Lambda sets PORT=8085, TOKEN, SERVICE, ENVIRONMENT.
# DbGate docker uses process.env.PORT (default 3000). Do not bind 8085 twice.
# Audit shutdown upload: same pattern as cdp-webshell/entrypoint.sh
audit_path=/var/log/webshell
mkdir -p "$audit_path"

_term() {
  echo "caught shutdown signal, stopping dbgate"
  kill -TERM "${child:-}" 2>/dev/null || true
}

trap _term SIGTERM
trap _term SIGINT

export SKIP_ALL_AUTH=1
export WEB_ROOT="/${TOKEN}"
DBGATE_ENGINE="${DBGATE_ENGINE:-mongo}"

case "${DBGATE_ENGINE}" in
  mongo)
    export CONNECTIONS=mongo
    export LABEL_mongo="${SERVICE}"
    export ENGINE_mongo=mongo@dbgate-plugin-mongo
    export SINGLE_CONNECTION=mongo
    export SINGLE_DATABASE="${SERVICE}"

    # A caller can set URL_mongo for a local database. ECS does not set it.
    if [ -z "${URL_mongo:-}" ]; then
      export URL_mongo="mongodb://protected-mongo-01.${ENVIRONMENT}.protected.cdp:27017,protected-mongo-02.${ENVIRONMENT}.protected.cdp:27017,protected-mongo-03.${ENVIRONMENT}.protected.cdp:27017/${SERVICE}?authSource=\$external&authMechanism=MONGODB-AWS&tls=true&readPreference=secondaryPreferred&tlsAllowInvalidCertificates=true"
    fi

    # Log Mongo driver commands to stdout and AUDIT_LOG_PATH. See mongo-audit-preload.js.
    export AUDIT_LOG_PATH="${audit_path}/mongo.audit"
    export NODE_OPTIONS="--require /opt/cdp-audit/mongo-audit-preload.js${NODE_OPTIONS:+ ${NODE_OPTIONS}}"
    ;;
  redis)
    if [ -z "${REDIS_HOST:-}" ]; then
      echo "REDIS_HOST must be set when DBGATE_ENGINE=redis" >&2
      exit 1
    fi

    export CONNECTIONS=redis
    export LABEL_redis="${SERVICE}"
    export ENGINE_redis=redis@dbgate-plugin-redis
    export SINGLE_CONNECTION=redis
    # CDP Redis is cluster mode with a single shard, so every slot lives on the node behind the
    # configuration endpoint and DbGate's standalone client works.
    # DbGate's cluster client is Premium-only, so a multi-shard cluster would need a different approach.
    export SERVER_redis="${REDIS_HOST}"
    export PORT_redis="${REDIS_PORT:-6379}"
    # Same pattern as mongo: SINGLE_DATABASE opens the DB in the UI. DATABASE_redis alone
    # leaves singleDbConnection null and the UI stuck on "Database not selected".
    # CDP Redis (cluster) only has db0. See README.
    export SINGLE_DATABASE=db0
    # DbGate treats any non-empty USE_SSL_redis as true, including "false", so only set it for TLS.
    if [ "${REDIS_TLS:-true}" != "false" ]; then
      export USE_SSL_redis=1
    fi

    if [ -n "${REDIS_USERNAME:-}" ]; then
      export USER_redis="${REDIS_USERNAME}"
    fi
    if [ -n "${REDIS_PASSWORD:-}" ]; then
      export PASSWORD_redis="${REDIS_PASSWORD}"
    fi

    # Log Redis commands to stdout and AUDIT_LOG_PATH. See redis-audit-preload.js.
    export AUDIT_LOG_PATH="${audit_path}/redis.audit"
    export NODE_OPTIONS="--require /opt/cdp-audit/redis-audit-preload.js${NODE_OPTIONS:+ ${NODE_OPTIONS}}"
    ;;
  *)
    echo "invalid DBGATE_ENGINE '${DBGATE_ENGINE}', expected 'mongo' or 'redis'" >&2
    exit 1
    ;;
esac

echo "starting dbgate ENGINE=${DBGATE_ENGINE} PORT=${PORT} WEB_ROOT=${WEB_ROOT} SERVICE=${SERVICE} ENVIRONMENT=${ENVIRONMENT}"

# DbGate call api.dbgate.cloud on every UI load (public files + promo widget). Through the CDP forwarder that fails
# with axios "Unsupported protocol file:" and a snackbar toast.
# LOCAL_DBGATE_CLOUD makes DbGate use http://localhost:3110 instead; we serve empty OK responses there.
export LOCAL_DBGATE_CLOUD=1
export NO_PROXY="127.0.0.1,localhost${NO_PROXY:+,${NO_PROXY}}"
export no_proxy="${NO_PROXY}"
node /opt/cdp/cloud-stub.js &

node bundle.js --listen-api &
child=$!

child_exit=0
wait "$child" || child_exit=$?
# A trapped signal makes the first wait return before node exits; wait again so the audit file is complete before it is tarred.
wait "$child" 2>/dev/null || true

if [ -n "${AUDIT_UPLOAD_URL:-}" ]; then
  url="$(printf '%s' "$AUDIT_UPLOAD_URL" | base64 -d)"
  file_to_upload="${audit_path}/audit.tgz"
  find "$audit_path" -type f -name "*.audit" -exec tar --no-recursion --transform 's|^.*/||' -czf "$file_to_upload" {} +

  if [ -f "$file_to_upload" ]; then
    echo "uploading audit file [${file_to_upload}] to s3"
    curl --fail --silent --show-error --noproxy '*' --request PUT --upload-file "${file_to_upload}" "$url"
  else
    echo "no audit file found: [${file_to_upload}]"
  fi
else
  echo "no AUDIT_UPLOAD_URL set, skipping audit upload"
fi

exit "$child_exit"
