# cdp-dbgate

This is a container based on [DbGate](https://github.com/dbgate/dbgate) that runs MongoDB and Redis web UIs in a way
that works with the cdp-webshell launcher.

## Whats in it?

- `dbgate`: web-ui for interacting with MongoDB and Redis
- `aws4`: Node helper used by the mongo driver for `MONGODB-AWS` auth

## Setup/config

The webshell lambda sets these environment variables. This image must honour them:

- `PORT` — listen port (lambda uses `8085`)
- `TOKEN` — unique session prefix; DbGate is served under `WEB_ROOT=/${TOKEN}`
- `SERVICE` — tenant / database name and IAM identity
- `ENVIRONMENT` — used to build the protected mongo hostnames

### Optional

- `DBGATE_ENGINE` — `mongo` (default) or `redis`
- `READONLY_mongo=1` — makes the DbGate UI read-only. Not set today (users have write access); add it to the task
  environment if a read-only session is ever needed.

When `DBGATE_ENGINE=redis`:

- `REDIS_HOST` (required) — hostname of the Redis endpoint
- `REDIS_PORT` (optional, default `6379`)
- `REDIS_TLS` (optional, TLS is on unless set to `false`, e.g. for plain local Redis)
- `REDIS_USERNAME` and `REDIS_PASSWORD` (optional; used when present)

### Redis is pinned to `db0`

A Redis server has numbered logical databases, `db0` to `db15` by default. Each holds its own keys, and a client
switches between them with `SELECT`. DbGate lists all of them, even empty ones.

CDP Redis (ElastiCache) runs in cluster mode, which only supports `db0`. Tenants share it and are kept apart by key
prefix: each service's Redis user can only access keys starting with its own prefix (`REDIS_KEY_PREFIX`).
`entrypoint.sh` therefore sets `SINGLE_DATABASE=db0` (same pattern as Mongo), so DbGate opens `db0` directly and
doesn't list the other databases.

### DbGate connects to the primary

CDP Redis is one shard: a primary and replicas, behind the configuration endpoint in `REDIS_HOST`. DNS resolves
that endpoint to any node. A replica answers `SCAN` but replies `MOVED` to key commands (`GET`, `SET`, opening a key).
`redis-cli -c` follows `MOVED`. DbGate's free Redis client is standalone and does not: the cluster client
(`Redis.Cluster`) is Premium only.

Before DbGate starts, `entrypoint.sh` runs `redis-primary.js`. It runs `CLUSTER NODES` on the endpoint, takes the one
primary that owns slots, checks it answers `PING` with the same TLS and credentials, and sets `SERVER_redis` to its
hostname. If any step fails, or there is more than one shard, it logs `redis.primary` `skipped` with a reason and
DbGate uses `REDIS_HOST`, as before.

If the primary fails over during a session, that session gets `MOVED` until it is relaunched.

### Key list is scoped to the service

The service ACL (`on ~<service>:* +@all -@dangerous`) blocks reading or writing other services' keys, but `SCAN` takes
no key argument, so it returns every key name in the shared cluster. DbGate's key browser runs `SCAN` on open, so
without scoping it lists every tenant's keys, and theirs open as a blank panel.

`redis-preload.js` rewrites the `MATCH` pattern of every `SCAN` to start with `REDIS_SCAN_PREFIX`
(`entrypoint.sh` sets it to `${SERVICE}:`). This covers the key browser, its filter box and `SCAN` typed in the query
tab. For example, `*` becomes `cdp-portal-frontend:*`.

This is for clarity, not security: the ACL is the control, and the terminal's `redis-cli` can still `SCAN` all key
names. The key list's "Scanned X/Y" total comes from `DBSIZE` and is still cluster-wide.

The service's keys are a small part of the shared keyspace, so DbGate's 2000-slot page is usually empty. The preload
wraps the Redis driver's `scanKeys` to keep scanning 2000-slot pages until keys turn up, the cursor ends, or 5 seconds
pass, so no single `SCAN` blocks the shared primary. "Scan all" is unchanged. A newer scan on the same connection
(a filter change, Refresh, a key edit) stops the older one after its current page. DbGate still adds 2000 to
"Scanned X/Y" per call, so after a scan that went through several pages the counter understates progress. See
`redis-key-browser.js`.

## Audit logging

Each engine has a preload that `entrypoint.sh` loads into DbGate with `NODE_OPTIONS=--require`. Both write through
`audit-log.js`, one JSON line per command, carrying `userId` (from `USER_ID`), `service`, `environment` and `token`.

| Engine | Preload                  | Hooks                                 | `msg`           | Body field | Skipped                                                     |
| ------ | ------------------------ | ------------------------------------- | --------------- | ---------- | ----------------------------------------------------------- |
| Mongo  | `mongo-audit-preload.js` | driver `MongoClient` events           | `mongo.command` | `command`  | `hello`, `ping`, `saslStart`, …                             |
| Redis  | `redis-preload.js`       | ioredis `Redis.prototype.sendCommand` | `redis.command` | `args`     | `auth`, `hello`, `ping`, `select`, `client`, `info`, `quit` |

Redis `auth` and `hello` carry the password, so they are never logged.

A key browser page sends `SCAN` and `DBSIZE` per page, then `TYPE` and up to 5 size commands per key. These only reveal
key names, so they are audited as one `scanKeys` line per page instead, with `args` holding `filter`, the start
`cursor`, `pages`, `nextCursor` and the listed `keys` (and `error` if it failed). Commands from the query tab and from
opening a key are still logged one per line.

- The full line, including the body field, goes to `AUDIT_LOG_PATH`, which `entrypoint.sh` sets to
  `/var/log/webshell/<engine>.audit`. This file is the audit record uploaded to S3.
- The same line without the body goes to stdout (docker logs / Firelens → OpenSearch), so values that may
  contain personal data stay out of the general log store.
- On `SIGTERM`/`SIGINT`, `entrypoint.sh` waits for DbGate to exit, tars `*.audit` into `/var/log/webshell/audit.tgz`
  and `PUT`s it to the base64-decoded `AUDIT_UPLOAD_URL` (a presigned S3 URL from the webshell lambda). A failed
  upload is logged by `curl`.

Tests use the built-in Node runner, no dependencies, Mongo or Redis needed:

```bash
node --test
```

## DbGate cloud stub

DbGate fetches “public cloud” files and a promo widget from `api.dbgate.cloud` on every UI load. In CDP, egress goes
through the sidecar HTTP proxy, where that call fails and DbGate shows a toast (`Unsupported protocol file:`).

`entrypoint.sh` sets `LOCAL_DBGATE_CLOUD=1`, which makes DbGate call `http://localhost:3110` instead, and starts
`cloud-stub.js` there to answer with empty data. `localhost` is added to `NO_PROXY` so the stub is reached directly.
The image also turns off DbGate usage analytics at build time (see `Dockerfile`).

## Local run (standalone, no other deps)

This starts only `cdp-dbgate`, Mongo and Redis from this repository. Pick one or both with a profile:

```bash
docker compose --profile redis up -d --build                    # Redis only
docker compose --profile mongo up -d --build                    # Mongo only
docker compose --profile redis --profile mongo up -d --build    # both
```

- Mongo UI: `http://localhost:8085/demo/`
- Redis UI: `http://localhost:8086/demo/`

Each profile seeds demo data into its backend. Stop with the same profiles, e.g.
`docker compose --profile redis --profile mongo down -v`.

`redis-cluster` is one shard like CDP: `redis-primary` and `redis-replica`, with DbGate pointed at the replica.

```bash
docker compose --profile redis-cluster up -d --build
docker compose logs dbgate-redis-cluster | grep redis.primary   # "status":"ok","host":"redis-primary"
```

Redis Cluster UI: `http://localhost:8087/demo/`. `GET demo-service:string:welcome` returns `"hello-from-the-primary"`.
To see the problem without the fix, run an image built before it: `DBGATE_IMAGE=<old-tag> docker compose --profile
redis-cluster up -d --no-build`. The same `GET` fails with `MOVED`. `--no-build` stops compose from building the
current code under the old tag if that image is missing.

## Local

`run-local.sh` starts this image and registers the Portal session token with the webshell proxy. `USER_ID` defaults to
`local-user`. It runs `cdp-dbgate:local` (override with `IMAGE`), the same tag `docker compose` builds.

```bash
docker build -t cdp-dbgate:local .
./run-local.sh <token-or-portal-url> [service]
```

`service` defaults to `cdp-portal-backend`. Launch **MongoDB Web UI** in the local Portal first, then pass the token
from the browser URL. The webshell proxy must already be running on `http://localhost:8000`.
Register always sends `owner_id`, which the proxy checks when `USER_AUTH_ENABLED=true` (default: journey-tests
Admin User `90552794-0613-4023-819a-512aa9d40023`). Override with `OWNER_ID` if you log in as
someone else.

Use `DBGATE_ENGINE` to choose local Mongo or Redis:

```bash
# Mongo mode (default)
./run-local.sh <token-or-portal-url> [service]

# Redis mode against journey-tests/local Redis
DBGATE_ENGINE=redis REDIS_HOST=host.docker.internal REDIS_PORT=6379 REDIS_TLS=false ./run-local.sh <token-or-portal-url> cdp-portal-frontend
```

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
