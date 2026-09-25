#!/bin/bash
set -euo pipefail

# Lambda sets PORT=8085, TOKEN, SERVICE, ENVIRONMENT.
# DbGate docker uses process.env.PORT (default 3000). Do not bind 8085 twice.
# Audit shutdown upload: same pattern as cdp-webshell/entrypoint.sh
audit_path=/var/log/webshell
mkdir -p "$audit_path"
export AUDIT_LOG_PATH="${audit_path}/mongo.audit"

_term() {
  echo "caught shutdown signal, stopping dbgate"
  kill -TERM "${child:-}" 2>/dev/null || true
}

trap _term SIGTERM
trap _term SIGINT

export SKIP_ALL_AUTH=1
export WEB_ROOT="/${TOKEN}"
export CONNECTIONS=mongo
export LABEL_mongo="${SERVICE}"
export ENGINE_mongo=mongo@dbgate-plugin-mongo
export SINGLE_CONNECTION=mongo
export SINGLE_DATABASE="${SERVICE}"

# A caller can set URL_mongo for a local database. ECS does not set it.
if [ -z "${URL_mongo:-}" ]; then
  export URL_mongo="mongodb://protected-mongo-01.${ENVIRONMENT}.protected.cdp:27017,protected-mongo-02.${ENVIRONMENT}.protected.cdp:27017,protected-mongo-03.${ENVIRONMENT}.protected.cdp:27017/${SERVICE}?authSource=\$external&authMechanism=MONGODB-AWS&tls=true&readPreference=secondaryPreferred&tlsAllowInvalidCertificates=true"
fi

echo "starting dbgate PORT=${PORT} WEB_ROOT=${WEB_ROOT} SERVICE=${SERVICE} ENVIRONMENT=${ENVIRONMENT}"

# DbGate call api.dbgate.cloud on every UI load (public files + promo widget). Through the CDP forwarder that fails
# with axios "Unsupported protocol file:" and a snackbar toast.
# LOCAL_DBGATE_CLOUD makes DbGate use http://localhost:3110 instead; we serve empty OK responses there.
export LOCAL_DBGATE_CLOUD=1
export NO_PROXY="127.0.0.1,localhost${NO_PROXY:+,${NO_PROXY}}"
export no_proxy="${NO_PROXY}"
node /opt/cdp/cloud-stub.js &

# Log Mongo driver commands to stdout and AUDIT_LOG_PATH. See mongo-audit-preload.js.
export NODE_OPTIONS="--require /opt/cdp-audit/mongo-audit-preload.js${NODE_OPTIONS:+ ${NODE_OPTIONS}}"

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
