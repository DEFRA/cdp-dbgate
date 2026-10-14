'use strict'

// Audit Mongo driver commands to stdout (docker logs / Firelens) and to AUDIT_LOG_PATH,
// which entrypoint.sh uploads on shutdown. Loaded via NODE_OPTIONS=--require before DbGate starts.

const Module = require('module')
const { audit, AUDIT_LOG_PATH } = require('./audit-log')

const SKIP = new Set([
  'hello',
  'ismaster',
  'isMaster',
  'saslStart',
  'saslContinue',
  'ping',
  'endSessions'
])

function onCommandStarted(event) {
  if (SKIP.has(event.commandName)) {
    return
  }

  audit(
    'mongo',
    {
      commandName: event.commandName,
      databaseName: event.databaseName,
      requestId: event.requestId,
      command: event.command
    },
    'command'
  )
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
