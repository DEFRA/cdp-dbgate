'use strict'

// Audit Mongo driver commands to stdout (docker logs / Firelens) and to AUDIT_LOG_PATH,
// which entrypoint.sh uploads on shutdown. Loaded via NODE_OPTIONS=--require before DbGate starts.

const fs = require('fs')
const Module = require('module')

const SKIP = new Set([
  'hello',
  'ismaster',
  'isMaster',
  'saslStart',
  'saslContinue',
  'ping',
  'endSessions'
])

// Set by entrypoint.sh, which also creates the directory and owns the upload. Unset means stdout only.
const AUDIT_LOG_PATH = process.env.AUDIT_LOG_PATH

// DbGate turns large integers into BigInt, which plain JSON.stringify throws on. A throw here
// would surface in the driver and fail the user's query.
function toJson(value) {
  return JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v))
}

function writeAuditLine(line) {
  if (!AUDIT_LOG_PATH) {
    return
  }
  try {
    fs.appendFileSync(AUDIT_LOG_PATH, `${line}\n`)
  } catch (err) {
    console.log(
      JSON.stringify({
        msg: 'mongo.audit.write.error',
        path: AUDIT_LOG_PATH,
        error: err && err.message
      })
    )
  }
}

function onCommandStarted(event) {
  if (SKIP.has(event.commandName)) {
    return
  }

  const entry = {
    msg: 'mongo.command',
    ts: new Date().toISOString(),
    commandName: event.commandName,
    databaseName: event.databaseName,
    requestId: event.requestId,
    command: event.command,
    userId: process.env.USER_ID || null,
    service: process.env.SERVICE,
    environment: process.env.ENVIRONMENT,
    token: process.env.TOKEN
  }

  // Full command (may contain document bodies) goes only to the S3 audit file; stdout feeds OpenSearch.
  writeAuditLine(toJson(entry))
  console.log(toJson({ ...entry, command: undefined }))
}

function installAuditedClient(exports, Original) {
  function AuditedMongoClient(url, options) {
    const opts = Object.assign({}, options || {}, { monitorCommands: true })
    const client = new Original(url, opts)
    client.on('commandStarted', onCommandStarted)
    return client
  }

  AuditedMongoClient.__cdpAuditPatched = true
  AuditedMongoClient.prototype = Original.prototype
  Object.setPrototypeOf(AuditedMongoClient, Original)

  try {
    Object.defineProperty(exports, 'MongoClient', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: AuditedMongoClient
    })
    console.log(JSON.stringify({ msg: 'mongo.audit.patched', status: 'ok' }))
  } catch (err) {
    console.log(
      JSON.stringify({
        msg: 'mongo.audit.patch.error',
        error: err && err.message
      })
    )
  }
}

function patchMongoExports(exports) {
  if (!exports || typeof exports !== 'object') {
    return exports
  }

  let Original
  try {
    Original = exports.MongoClient
  } catch (_) {
    return exports
  }

  if (!Original || Original.__cdpAuditPatched) {
    return exports
  }

  installAuditedClient(exports, Original)
  return exports
}

function shouldPatch(id) {
  return id === 'mongodb' || id === 'mongodb-old'
}

// Intercept require('mongodb') so every MongoClient gets commandStarted auditing.
const originalRequire = Module.prototype.require
Module.prototype.require = function (id) {
  const exported = originalRequire.apply(this, arguments)
  if (shouldPatch(id)) {
    try {
      return patchMongoExports(exported)
    } catch (_) {
      return exported
    }
  }
  return exported
}

console.log(
  JSON.stringify({
    msg: 'mongo.audit.preload',
    status: 'loaded',
    path: AUDIT_LOG_PATH
  })
)

module.exports = { onCommandStarted }
