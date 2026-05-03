#!/bin/bash
set -euo pipefail

SSH_PORT="${SSH_PORT:-2357}"
LB_HOST="${LB_HOST:-103.252.74.109}"
LB_USER="${LB_USER:-root}"
NODE_USER="${NODE_USER:-root}"
NODE1_HOST="${NODE1_HOST:-172.16.10.253}"
NODE2_HOST="${NODE2_HOST:-172.16.10.216}"

LB="${LB_USER}@${LB_HOST}"
NODE1="${NODE_USER}@${NODE1_HOST}"
NODE2="${NODE_USER}@${NODE2_HOST}"
SSH_OPTS="-p ${SSH_PORT} -o StrictHostKeyChecking=no -o ConnectTimeout=10"

run_ssh() {
  local host="$1"
  local cmd="$2"
  ssh ${SSH_OPTS} "${host}" "${cmd}"
}

run_via_lb() {
  local target="$1"
  local cmd="$2"
  ssh ${SSH_OPTS} "${LB}" "ssh ${SSH_OPTS} ${target} \"${cmd}\""
}

echo "== LB health =="
run_ssh "${LB}" "curl -fsS http://127.0.0.1/health"

echo "== Node1 =="
run_via_lb "${NODE1}" "pm2 status game64x64 | sed -n '1,15p'"
run_via_lb "${NODE1}" "curl -fsS http://127.0.0.1:3000/health"

echo "== Node2 =="
run_via_lb "${NODE2}" "pm2 status game64x64 | sed -n '1,15p'"
run_via_lb "${NODE2}" "curl -fsS http://127.0.0.1:3000/health"

echo "== Data reachability from Node1 =="
run_via_lb "${NODE1}" "nc -z -w2 172.16.10.202 6379 && echo redis_ok || echo redis_fail"
run_via_lb "${NODE1}" "nc -z -w2 127.0.0.1 37018 && echo mongo_tunnel_ok || echo mongo_tunnel_fail"

echo "== Data reachability from Node2 =="
run_via_lb "${NODE2}" "nc -z -w2 172.16.10.202 6379 && echo redis_ok || echo redis_fail"
run_via_lb "${NODE2}" "nc -z -w2 127.0.0.1 37018 && echo mongo_tunnel_ok || echo mongo_tunnel_fail"

echo "Cluster healthcheck done."
