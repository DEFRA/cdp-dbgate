# cdp-dbgate

This is a container based on [DbGate](https://github.com/dbgate/dbgate) that runs a MongoDB web UI in a way that works
with the cdp-webshell launcher.

## Whats in it?

- `dbgate`: web-ui for interacting with MongoDB
- `aws4`: Node helper used by the mongo driver for `MONGODB-AWS` auth

## Setup/config

The webshell lambda sets these environment variables. This image must honour them:

- `PORT` — listen port (lambda uses `8085`)
- `TOKEN` — unique session prefix; DbGate is served under `WEB_ROOT=/${TOKEN}`
- `SERVICE` — tenant / database name and IAM identity
- `ENVIRONMENT` — used to build the protected mongo hostnames

### Optional

- `READONLY_mongo=1` — makes the DbGate UI read-only. Not set today (users have write access); add it to the task
  environment if a read-only session is ever needed.

## Audit logging

`mongo-audit-preload.js` is loaded into DbGate with `NODE_OPTIONS=--require`. It wraps the driver's `MongoClient` and
logs every command as one JSON line with `msg: "mongo.command"`. Handshake and auth commands (`hello`, `ping`,
`saslStart`, …) are skipped. Each line carries `userId` (from `USER_ID`), `service`, `environment` and `token`.

- The full line, including the `command` body, goes to `AUDIT_LOG_PATH`, which `entrypoint.sh` sets to
  `/var/log/webshell/mongo.audit`. This file is the audit record uploaded to S3.
- The same line without `command` goes to stdout (docker logs / Firelens → OpenSearch), so document bodies that may
  contain personal data stay out of the general log store.
- On `SIGTERM`/`SIGINT`, `entrypoint.sh` waits for DbGate to exit, tars `*.audit` into `/var/log/webshell/audit.tgz`
  and `PUT`s it to the base64-decoded `AUDIT_UPLOAD_URL` (a presigned S3 URL from the webshell lambda). A failed
  upload is logged by `curl`.

Tests use the built-in Node runner, no dependencies or Mongo needed:

```bash
node --test
```

## DbGate cloud stub

DbGate fetches “public cloud” files and a promo widget from `api.dbgate.cloud` on every UI load. In CDP, egress goes
through the sidecar HTTP proxy, where that call fails and DbGate shows a toast (`Unsupported protocol file:`).

`entrypoint.sh` sets `LOCAL_DBGATE_CLOUD=1`, which makes DbGate call `http://localhost:3110` instead, and starts
`cloud-stub.js` there to answer with empty data. `localhost` is added to `NO_PROXY` so the stub is reached directly.
The image also turns off DbGate usage analytics at build time (see `Dockerfile`).

## Local

`run-local.sh` starts this image against Mongo on the laptop (`127.0.0.1:27017`) and registers the Portal session token
with the webshell proxy. `USER_ID` defaults to `local-user`.

```bash
./run-local.sh <token-or-portal-url> [service]
```

`service` defaults to `cdp-portal-backend`. Launch **MongoDB Web UI** in the local Portal first, then pass the token
from the browser URL. The webshell proxy must already be running on `http://localhost:8000`.

### Local audit upload (floci)

Requires floci/LocalStack on `:4566`. Create a bucket once, then run with a base64 PUT URL:

```bash
aws --endpoint-url http://localhost:4566 s3 mb s3://cdp-webshell-audit

URL='http://host.docker.internal:4566/cdp-webshell-audit/audit/cdp-portal-backend/2026/09/25/sometoken123' AUDIT_UPLOAD_URL="$(printf '%s' "$URL" | base64 -w0)" ./run-local.sh sometoken123
```

Open `http://localhost:8085/sometoken123`, run a query, then:

```bash
docker exec cdp-dbgate-local cat /var/log/webshell/mongo.audit
docker stop cdp-dbgate-local
aws --endpoint-url http://localhost:4566 s3 ls s3://cdp-webshell-audit/audit/ --recursive
```

Proxy register errors on `:8000` can be ignored for this check.
