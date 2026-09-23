# cdp-dbgate

This is a container based on [DbGate](https://github.com/dbgate/dbgate) that runs a MongoDB web UI in a way that works with the cdp-webshell launcher.

## Whats in it?

- `dbgate`: web-ui for interacting with MongoDB
- `aws4`: Node helper used by the mongo driver for `MONGODB-AWS` auth

## Setup/config

The webshell lambda sets these environment variables. This image must honour them:

- `PORT` — listen port (lambda uses `8085`)
- `TOKEN` — unique session prefix; DbGate is served under `WEB_ROOT=/${TOKEN}`
- `SERVICE` — tenant / database name and IAM identity
- `ENVIRONMENT` — used to build the protected mongo hostnames

## Local

`run-local.sh` starts this image against Mongo on the laptop (`127.0.0.1:27017`) and registers the Portal session token with the webshell proxy.

```bash
./run-local.sh <token-or-portal-url> [service]
```

`service` defaults to `cdp-portal-backend`. Launch **MongoDB Web UI** in the local Portal first, then pass the token from the browser URL. The webshell proxy must already be running on `http://localhost:8000`.
