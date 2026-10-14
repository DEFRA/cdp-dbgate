'use strict'

// Prints the hostname of the Redis primary, or nothing if it cannot be used.
// entrypoint.sh points DbGate at it instead of the configuration endpoint. See README.

const TIMEOUT_MS = 5000

function log(fields) {
  console.error(JSON.stringify({ msg: 'redis.primary', ...fields }))
}

// One CLUSTER NODES line: <id> <ip:port@cport[,hostname]> <flags> <master> <ping> <pong> <epoch> <link> [slots...]
function parseNode(line) {
  const fields = line.trim().split(/\s+/)
  if (fields.length < 8) {
    return null
  }

  const [hostPort, busAndHostname = ''] = fields[1].split('@')
  const hostname = busAndHostname.split(',')[1]
  const host = hostname || hostPort.slice(0, hostPort.lastIndexOf(':'))

  return {
    host,
    flags: fields[2].split(','),
    connected: fields[7] === 'connected',
    hasSlots: fields.length > 8
  }
}

function isUsablePrimary(node) {
  if (!node) {
    return false
  }

  const isPrimary = node.flags.includes('master')
  // `fail?` is suspected by the node we asked, `fail` is confirmed by the cluster.
  const isDown = node.flags.some((flag) => flag.startsWith('fail'))
  const hasAddress = !node.flags.includes('noaddr')
  const isReachable = node.connected
  const holdsData = node.hasSlots

  return isPrimary && !isDown && hasAddress && isReachable && holdsData
}

// DbGate's free Redis client cannot follow MOVED, so it only works against the one primary
// that owns every slot. Anything else returns a reason and the caller keeps the endpoint.
function findPrimary(clusterNodes) {
  const primaries = clusterNodes
    .split('\n')
    .filter((line) => line.trim())
    .map(parseNode)
    .filter(isUsablePrimary)

  if (primaries.length !== 1) {
    return {
      reason: `expected 1 primary with slots, found ${primaries.length}`
    }
  }
  if (!primaries[0].host) {
    return { reason: 'primary has no address' }
  }
  return { host: primaries[0].host }
}

// Same settings DbGate gets: entrypoint.sh exports the *_redis variables before running this.
function connect(Redis, host) {
  const client = new Redis({
    host,
    port: Number(process.env.PORT_redis),
    username: process.env.USER_redis,
    password: process.env.PASSWORD_redis,
    tls: process.env.USE_SSL_redis ? {} : undefined,
    connectTimeout: TIMEOUT_MS,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null
  })
  // Connection errors also reject the pending command, which main() logs once.
  client.on('error', () => {})
  return client
}

async function main() {
  // ioredis ships with DbGate. Resolve it from there, not from this file's directory.
  const Redis = require(
    require.resolve('ioredis', {
      paths: [process.env.DBGATE_HOME || '/home/dbgate-docker']
    })
  )

  const endpoint = connect(Redis, process.env.REDIS_HOST)
  let found
  try {
    found = findPrimary(await endpoint.cluster('NODES'))
  } finally {
    endpoint.disconnect()
  }
  if (!found.host) {
    log({ status: 'skipped', reason: found.reason })
    return
  }

  // Check the primary accepts our TLS and credentials before handing it to DbGate.
  const primary = connect(Redis, found.host)
  try {
    await primary.ping()
  } finally {
    primary.disconnect()
  }

  log({ status: 'ok', host: found.host })
  process.stdout.write(found.host)
}

if (require.main === module) {
  const timer = setTimeout(() => {
    log({ status: 'skipped', reason: 'timeout' })
    process.exit(0)
  }, TIMEOUT_MS * 2)

  main()
    .catch((err) => log({ status: 'skipped', reason: err && err.message }))
    .finally(() => {
      clearTimeout(timer)
      process.exit(0)
    })
}

module.exports = { findPrimary }
