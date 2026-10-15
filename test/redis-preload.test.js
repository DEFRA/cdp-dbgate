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

const { patchRedis, scopeScan } = require('../redis-preload')
const { patchDriver } = require('../redis-key-browser')

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
    const command = { name: 'scan', args: ['0', 'MATCH', '*'] }
    scopeScan(command)
    assert.deepEqual(command.args, ['0', 'MATCH', 'svc:*'])
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

test('a COUNT typed in the query tab is respected', () => {
  withScanPrefix('svc:', () => {
    const command = { name: 'scan', args: ['0', 'MATCH', '*', 'COUNT', '10'] }
    scopeScan(command)
    assert.deepEqual(command.args, ['0', 'MATCH', 'svc:*', 'COUNT', '10'])
  })
})

// Serves `pages` in order; each page is the keys found before the next cursor. Like DbGate's driver,
// it sends SCAN, DBSIZE and a TYPE per key through ioredis, after an await.
function fakeRedisPlugin(pages = [[]], onScan = () => {}) {
  const calls = []
  const redis = new FakeRedis()
  const driver = {
    async scanKeys(dbhan, pattern, cursor, count) {
      calls.push({ cursor, count })
      onScan()
      const index = calls.length - 1
      if (pages[index] instanceof Error) {
        throw pages[index]
      }
      const nextCursor = index + 1 < pages.length ? String(index + 1) : '0'
      await Promise.resolve()
      redis.sendCommand({ name: 'scan', args: [cursor, 'MATCH', '*'] })
      redis.sendCommand({ name: 'dbsize', args: [] })
      await Promise.resolve()
      for (const key of pages[index]) {
        redis.sendCommand({ name: 'type', args: [key] })
      }
      return { nextCursor, keys: pages[index].map((key) => ({ key })) }
    }
  }
  return { plugin: { drivers: [driver] }, driver, calls }
}

test("the key browser keeps scanning past empty pages until it finds the service's keys", async () => {
  const { plugin, driver, calls } = fakeRedisPlugin([[], [], ['svc:a']])
  patchDriver(plugin)

  const page = await driver.scanKeys({}, '', '0', 2000)

  assert.deepEqual(calls, [
    { cursor: '0', count: 2000 },
    { cursor: '1', count: 2000 },
    { cursor: '2', count: 2000 }
  ])
  assert.deepEqual(page, { nextCursor: '0', keys: [{ key: 'svc:a' }] })
})

test('the key browser stops at the end of the keyspace even with no keys', async () => {
  const { plugin, driver, calls } = fakeRedisPlugin([[], []])
  patchDriver(plugin)

  const page = await driver.scanKeys({}, '', '0', 2000)

  assert.equal(calls.length, 2)
  assert.deepEqual(page, { nextCursor: '0', keys: [] })
})

test('the key browser hands back an empty page when the scan times out', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] })
  const { plugin, driver, calls } = fakeRedisPlugin(
    [[], [], [], ['svc:a']],
    () => t.mock.timers.tick(3000)
  )
  patchDriver(plugin)

  const page = await driver.scanKeys({}, '', '0', 2000)

  assert.equal(calls.length, 2)
  assert.deepEqual(page, { nextCursor: '2', keys: [] })
})

test('a newer key browser scan on the same connection stops the older one after its page', async () => {
  const { plugin, driver, calls } = fakeRedisPlugin([[], [], [], ['svc:a']])
  patchDriver(plugin)
  const dbhan = {}

  const older = driver.scanKeys(dbhan, 'a', '0', 2000)
  const newer = driver.scanKeys(dbhan, 'ab', '0', 2000)

  assert.deepEqual(await older, { nextCursor: '1', keys: [] })
  assert.deepEqual(await newer, { nextCursor: '0', keys: [{ key: 'svc:a' }] })
  assert.equal(calls.length, 4)
})

test('key browser scans on different connections do not stop each other', async () => {
  const { plugin, driver } = fakeRedisPlugin([
    [],
    [],
    [],
    [],
    ['svc:a'],
    ['svc:b']
  ])
  patchDriver(plugin)

  const pages = await Promise.all([
    driver.scanKeys({}, '', '0', 2000),
    driver.scanKeys({}, '', '0', 2000)
  ])

  assert.deepEqual(
    pages.map((page) => page.keys.length),
    [1, 1]
  )
})

test('"Scan all" sends no count and makes one call', async () => {
  const { plugin, driver, calls } = fakeRedisPlugin([[], ['svc:a']])
  patchDriver(plugin)

  await driver.scanKeys({}, '', '0', undefined)

  assert.deepEqual(calls, [{ cursor: '0', count: undefined }])
})

test('a key browser page is audited as one line listing its keys', async () => {
  const { plugin, driver } = fakeRedisPlugin([[], ['svc:a', 'svc:b']])
  patchDriver(plugin)
  const before = readLines().length

  await driver.scanKeys({}, 'svc', '0', 2000)

  const lines = readLines().slice(before)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].commandName, 'scanKeys')
  assert.deepEqual(lines[0].args, {
    filter: 'svc',
    cursor: '0',
    pages: 2,
    nextCursor: '0',
    keys: ['svc:a', 'svc:b']
  })
})

test('a query tab command sent during a key browser scan is still audited', async () => {
  const { plugin, driver } = fakeRedisPlugin([['svc:a']])
  patchDriver(plugin)
  const before = readLines().length

  const scan = driver.scanKeys({}, '', '0', 2000)
  new FakeRedis().sendCommand({ name: 'get', args: ['svc:b'] })
  await scan

  const names = readLines()
    .slice(before)
    .map((line) => line.commandName)
  assert.deepEqual(names, ['get', 'scanKeys'])
})

test('a failed key browser scan is audited with its error', async () => {
  const { plugin, driver } = fakeRedisPlugin([[], new Error('NOPERM')])
  patchDriver(plugin)

  await assert.rejects(driver.scanKeys({}, '', '0', 2000), /NOPERM/)

  const line = readLines().at(-1)
  assert.equal(line.commandName, 'scanKeys')
  assert.equal(line.error, 'NOPERM')
  assert.deepEqual(line.args, { filter: '', cursor: '0', pages: 1 })
})

test('patching the driver twice does not wrap it twice', () => {
  const { plugin, driver } = fakeRedisPlugin()
  patchDriver(plugin)
  const patched = driver.scanKeys
  patchDriver(plugin)

  assert.equal(driver.scanKeys, patched)
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
