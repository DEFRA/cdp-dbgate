#!/bin/bash
set -euo pipefail

# Lambda sets PORT=8085, TOKEN, SERVICE, ENVIRONMENT.
# DbGate docker uses process.env.PORT (default 3000). Do not bind 8085 twice.

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

exec node bundle.js --listen-api
