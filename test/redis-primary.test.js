'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { findPrimary } = require('../redis-primary')

const host = (id) =>
  `cdp-infra-dev-public-redis-${id}.cdp-infra-dev-public-redis.hh503j.euw2.cache.amazonaws.com`

test('ElastiCache: picks the primary when connected to a replica', () => {
  const nodes = [
    `aaa ${host('0001-001')}:6379@1122 master - 0 1 0 connected 0-16383`,
    `bbb ${host('0001-002')}:6379@1122 slave aaa 0 1 0 connected`,
    `ccc ${host('0001-003')}:6379@1122 myself,slave aaa 0 0 0 connected`
  ].join('\n')

  assert.deepEqual(findPrimary(nodes), { host: host('0001-001') })
})

test('Redis 7 hostname after the bus port is used instead of the IP', () => {
  const nodes = [
    'aaa 172.19.0.2:6379@16379,redis-primary master - 0 1 0 connected 0-16383',
    'bbb 172.19.0.3:6379@16379,redis-replica myself,slave aaa 0 0 0 connected'
  ].join('\n')

  assert.deepEqual(findPrimary(nodes), { host: 'redis-primary' })
})

test('without a hostname the IP is used', () => {
  const nodes =
    'aaa 10.249.12.51:6379@1122 myself,master - 0 0 0 connected 0-16383\n'

  assert.deepEqual(findPrimary(nodes), { host: '10.249.12.51' })
})

test('more than one shard is skipped, the free DbGate client cannot route between them', () => {
  const nodes = [
    `aaa ${host('0001-001')}:6379@1122 master - 0 1 0 connected 0-8191`,
    `bbb ${host('0002-001')}:6379@1122 master - 0 1 0 connected 8192-16383`
  ].join('\n')

  assert.equal(findPrimary(nodes).host, undefined)
  assert.match(findPrimary(nodes).reason, /found 2/)
})

test('a failed or disconnected primary is not used', () => {
  const nodes = [
    `aaa ${host('0001-001')}:6379@1122 master,fail - 0 1 0 disconnected 0-16383`,
    `bbb ${host('0001-002')}:6379@1122 myself,slave aaa 0 0 0 connected`
  ].join('\n')

  assert.equal(findPrimary(nodes).host, undefined)
})

test('a primary that owns no slots is not used', () => {
  const nodes = `aaa ${host('0001-001')}:6379@1122 myself,master - 0 0 0 connected\n`

  assert.equal(findPrimary(nodes).host, undefined)
})
