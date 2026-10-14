'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

// The preload reads AUDIT_LOG_PATH once at load time, so set it before requiring.
const auditLogPath = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'redis-audit-')),
  'redis.audit'
)
process.env.AUDIT_LOG_PATH = auditLogPath

const { patchRedis } = require('../redis-audit-preload')

function readLines() {
  if (!fs.existsSync(auditLogPath)) {
    return []
  }
  return fs
    .readFileSync(auditLogPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse)
}

class FakeRedis {
  sendCommand(command) {
    return `sent:${command.name}`
  }
}
patchRedis(FakeRedis)

test('a write command is audited with its args and still sent', () => {
  const result = new FakeRedis().sendCommand({
    name: 'set',
    args: ['svc:key', Buffer.from('value')]
  })

  assert.equal(result, 'sent:set')
  const line = readLines().at(-1)
  assert.equal(line.msg, 'redis.command')
  assert.equal(line.commandName, 'set')
  assert.deepEqual(line.args, ['svc:key', 'value'])
})

test('auth is never written, so the password stays out of the audit file', () => {
  new FakeRedis().sendCommand({
    name: 'auth',
    args: ['svc-user', 'secret-password']
  })

  assert.ok(!fs.readFileSync(auditLogPath, 'utf8').includes('secret-password'))
})

test('patching twice does not double-log', () => {
  patchRedis(FakeRedis)
  const before = readLines().length

  new FakeRedis().sendCommand({ name: 'del', args: ['svc:key'] })

  assert.equal(readLines().length, before + 1)
})

test('a failed auth does not carry the password on its error', () => {
  let rejectedWith
  const command = {
    name: 'auth',
    args: ['svc-user', 'secret-password'],
    reject: (err) => (rejectedWith = err)
  }
  new FakeRedis().sendCommand(command)

  // What ioredis does on WRONGPASS before rejecting.
  const err = new Error('WRONGPASS')
  err.command = { name: command.name, args: command.args }
  command.reject(err)

  assert.deepEqual(rejectedWith.command.args, ['[redacted]'])
  assert.deepEqual(command.args, ['svc-user', 'secret-password'])
})
