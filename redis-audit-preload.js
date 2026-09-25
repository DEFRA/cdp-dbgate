'use strict'

// Audit Redis commands to stdout (docker logs / Firelens) and to AUDIT_LOG_PATH,
// which entrypoint.sh uploads on shutdown. Loaded via NODE_OPTIONS=--require before DbGate starts.

const Module = require('module')
const { audit, AUDIT_LOG_PATH } = require('./audit-log')

// `auth` and `hello` carry the password, so they must never be logged.
const CREDENTIAL_COMMANDS = new Set(['auth', 'hello'])
// Connection handshake and keep-alive.
const SKIP = new Set([
  ...CREDENTIAL_COMMANDS,
  'ping',
  'select',
  'client',
  'info',
  'quit'
])

function argToString(arg) {
  return Buffer.isBuffer(arg) ? arg.toString('utf8') : arg
}

// ioredis copies the command's args onto a failed command's error (err.command), and DbGate logs that error to stdout.
// A WRONGPASS (e.g. after a password rotation) would put the password in OpenSearch, so redact before anyone sees it.
function redactCredentialErrors(command) {
  if (
    !CREDENTIAL_COMMANDS.has(String(command.name).toLowerCase()) ||
    typeof command.reject !== 'function'
  ) {
    return
  }
  const reject = command.reject
  command.reject = function (err) {
    if (err && err.command) {
      err.command = { name: err.command.name, args: ['[redacted]'] }
    }
    return reject.apply(this, arguments)
  }
}

function onCommand(command) {
  const name = String(command.name).toLowerCase()
  if (SKIP.has(name)) {
    return
  }

  audit(
    'redis',
    { commandName: name, args: (command.args || []).map(argToString) },
    'args'
  )
}

// Every ioredis call, pipelines and cluster nodes included, goes through Redis.prototype.sendCommand.
function patchRedis(Redis) {
  const proto = Redis && Redis.prototype
  if (
    !proto ||
    typeof proto.sendCommand !== 'function' ||
    proto.sendCommand.__cdpAuditPatched
  ) {
    return
  }

  const originalSendCommand = proto.sendCommand
  proto.sendCommand = function (command) {
    try {
      redactCredentialErrors(command)
      onCommand(command)
    } catch (_) {
      // Never fail the user's command because auditing failed.
    }
    return originalSendCommand.apply(this, arguments)
  }
  proto.sendCommand.__cdpAuditPatched = true
  console.log(JSON.stringify({ msg: 'redis.audit.patched', status: 'ok' }))
}

// Intercept require('ioredis') so every Redis client gets command auditing.
const originalRequire = Module.prototype.require
Module.prototype.require = function (id) {
  const exported = originalRequire.apply(this, arguments)
  if (id === 'ioredis') {
    try {
      patchRedis(exported)
    } catch (err) {
      console.log(
        JSON.stringify({
          msg: 'redis.audit.patch.error',
          error: err && err.message
        })
      )
    }
  }
  return exported
}

console.log(
  JSON.stringify({
    msg: 'redis.audit.preload',
    status: 'loaded',
    path: AUDIT_LOG_PATH
  })
)

module.exports = { onCommand, patchRedis }
