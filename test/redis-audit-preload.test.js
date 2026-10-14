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

const { patchRedis, scopeScan } = require('../redis-audit-preload')

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

function withScanPrefix(prefix, fn) {
  const previous = process.env.REDIS_SCAN_PREFIX
  process.env.REDIS_SCAN_PREFIX = prefix
  try {
    fn()
  } finally {
    if (previous === undefined) {
      delete process.env.REDIS_SCAN_PREFIX
    } else {
      process.env.REDIS_SCAN_PREFIX = previous
    }
  }
}

test('scan for every key only lists the service prefix', () => {
  withScanPrefix('svc:', () => {
    const command = { name: 'scan', args: ['0', 'MATCH', '*', 'COUNT', '100'] }
    scopeScan(command)
    assert.deepEqual(command.args, ['0', 'MATCH', 'svc:*', 'COUNT', '100'])
  })
})

test('a filter typed in the key browser is searched inside the service prefix', () => {
  withScanPrefix('svc:', () => {
    const command = { name: 'SCAN', args: ['0', 'match', '*session*'] }
    scopeScan(command)
    assert.deepEqual(command.args, ['0', 'match', 'svc:*session*'])
  })
})

test('a pattern already inside the service prefix is unchanged', () => {
  withScanPrefix('svc:', () => {
    const command = { name: 'scan', args: ['0', 'MATCH', 'svc:tree:*'] }
    scopeScan(command)
    assert.deepEqual(command.args, ['0', 'MATCH', 'svc:tree:*'])
  })
})

test('a full key name pasted into the key browser filter still finds the key', () => {
  withScanPrefix('svc:', () => {
    const command = { name: 'scan', args: ['0', 'MATCH', '*svc:session*'] }
    scopeScan(command)
    assert.deepEqual(command.args, ['0', 'MATCH', 'svc:session*'])
  })
})

test('a second MATCH, which Redis uses, is scoped too', () => {
  withScanPrefix('svc:', () => {
    const command = { name: 'scan', args: ['0', 'MATCH', 'x', 'MATCH', '*'] }
    scopeScan(command)
    assert.deepEqual(command.args, ['0', 'MATCH', 'x', 'MATCH', 'svc:*'])
  })
})

test('scan without MATCH gets one for the service prefix', () => {
  withScanPrefix('svc:', () => {
    const command = { name: 'scan', args: ['0'] }
    scopeScan(command)
    assert.deepEqual(command.args, ['0', 'MATCH', 'svc:*'])
  })
})

test('another service prefix is searched inside ours, so it finds nothing', () => {
  withScanPrefix('svc:', () => {
    const command = {
      name: 'scan',
      args: ['0', Buffer.from('MATCH'), Buffer.from('other:*')]
    }
    scopeScan(command)
    assert.equal(command.args[2], 'svc:other:*')
  })
})

test('scan is sent and audited with the scoped pattern', () => {
  withScanPrefix('svc:', () => {
    new FakeRedis().sendCommand({ name: 'scan', args: ['0', 'MATCH', '*'] })
    assert.deepEqual(readLines().at(-1).args, ['0', 'MATCH', 'svc:*'])
  })
})

test('a scan that cannot be scoped is still audited and sent', () => {
  withScanPrefix('svc:', () => {
    // As on a Node older than 18, which has no Array.prototype.findLastIndex.
    const args = Object.assign(['0'], {
      findLastIndex() {
        throw new TypeError('findLastIndex is not a function')
      }
    })
    const before = readLines().length
    const result = new FakeRedis().sendCommand({ name: 'scan', args })
    assert.equal(result, 'sent:scan')
    assert.equal(readLines().length, before + 1)
  })
})

test('without REDIS_SCAN_PREFIX scan and other commands are unchanged', () => {
  withScanPrefix('', () => {
    const scan = { name: 'scan', args: ['0', 'MATCH', '*'] }
    scopeScan(scan)
    assert.deepEqual(scan.args, ['0', 'MATCH', '*'])
  })

  withScanPrefix('svc:', () => {
    const get = { name: 'get', args: ['other:key'] }
    scopeScan(get)
    assert.deepEqual(get.args, ['other:key'])
  })
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
