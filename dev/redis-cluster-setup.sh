#!/bin/sh
set -eu

# One shard like CDP ElastiCache: redis-primary owns every slot, redis-replica copies it.

primary=redis-primary
replica=redis-replica
prefix="${REDIS_PREFIX:-demo-service}"

wait_for() {
  i=0
  until eval "$1"; do
    i=$((i + 1))
    [ "$i" -lt 60 ] || { echo "timed out: $1" >&2; exit 1; }
    sleep 0.5
  done
}

# depends_on only waits for the containers to start, not for redis-server to listen.
wait_for "redis-cli -h $primary PING | grep -q PONG"
wait_for "redis-cli -h $replica PING | grep -q PONG"

redis-cli -h "$primary" CLUSTER ADDSLOTSRANGE 0 16383 || true
redis-cli -h "$primary" CLUSTER MEET "$(getent hosts "$replica" | awk '{print $1}')" 6379

primary_id="$(redis-cli -h "$primary" CLUSTER MYID)"
wait_for "redis-cli -h $replica CLUSTER NODES | grep -q $primary_id"
redis-cli -h "$replica" CLUSTER REPLICATE "$primary_id" || true
wait_for "redis-cli -h $replica CLUSTER INFO | grep -q 'cluster_state:ok'"
wait_for "redis-cli -h $replica INFO replication | grep -q 'master_link_status:up'"

redis-cli -c -h "$primary" SET "${prefix}:string:welcome" "hello-from-the-primary"
redis-cli -c -h "$primary" HSET "${prefix}:hash:user:alice" role admin enabled true

echo "redis cluster ready"
redis-cli -h "$replica" CLUSTER NODES
