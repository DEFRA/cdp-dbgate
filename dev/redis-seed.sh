#!/bin/sh
set -eu

redis_host="${REDIS_HOST:-redis}"
redis_port="${REDIS_PORT:-6379}"
prefix="${REDIS_PREFIX:-demo-service}"

redis_cli() {
  redis-cli -h "${redis_host}" -p "${redis_port}" "$@"
}

# compose waits for redis to be healthy. DEL first so a re-run doesn't append to the list again.
redis_cli DEL "${prefix}:list:jobs"
redis_cli SET "${prefix}:string:welcome" "hello-from-dbgate"
redis_cli HSET "${prefix}:hash:user:alice" role admin enabled true
redis_cli LPUSH "${prefix}:list:jobs" build test deploy
redis_cli SADD "${prefix}:set:regions" eu-west-2 eu-central-1 us-east-1
redis_cli ZADD "${prefix}:zset:scores" 100 alice 80 bob 120 carol
redis_cli SET "${prefix}:ttl:session" "temporary-value"
redis_cli EXPIRE "${prefix}:ttl:session" 900
redis_cli SET "${prefix}:tree:app:cache:hit-rate" "0.97"
redis_cli SET "${prefix}:tree:app:cache:miss-rate" "0.03"
redis_cli SET "${prefix}:tree:worker:queue:depth" "12"
# Another tenant's key. DbGate should not list it.
redis_cli SET "other-service:string:hidden" "not-yours"

echo "redis seed complete"
