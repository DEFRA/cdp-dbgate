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

exec node bundle.js --listen-api
