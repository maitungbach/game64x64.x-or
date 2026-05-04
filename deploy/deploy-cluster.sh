#!/bin/bash
set -euo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

DOMAIN="${DOMAIN:-colorbox64x64.online}"
REDIS_HOST="${REDIS_HOST:-172.16.10.202}"
REDIS_PORT="${REDIS_PORT:-6379}"
MONGO_TUNNEL_HOST="${MONGO_TUNNEL_HOST:-172.16.10.202}"
MONGO_TUNNEL_PORT="${MONGO_TUNNEL_PORT:-27017}"
PROJECT_PATH="${PROJECT_PATH:-/opt/game64x64}"
GIT_REPO="${GIT_REPO:-https://github.com/maitungbach/game64x64.x-or.git}"
GIT_BRANCH="${GIT_BRANCH:-no-walls-pickup}"
SSH_PORT="${SSH_PORT:-2357}"
LB_HOST="${LB_HOST:-103.252.74.109}"
LB_USER="${LB_USER:-root}"
LB="${LB_USER}@${LB_HOST}"
NODE1_HOST="${NODE1_HOST:-172.16.10.253}"
NODE2_HOST="${NODE2_HOST:-172.16.10.216}"
NODE_USER="${NODE_USER:-root}"
NODE1="${NODE_USER}@${NODE1_HOST}"
NODE2="${NODE_USER}@${NODE2_HOST}"

SSH_OPTS="-p ${SSH_PORT} -o StrictHostKeyChecking=no -o ConnectTimeout=15"

log() {
  echo -e "${GREEN}[$(date +'%H:%M:%S')] $1${NC}"
}

warn() {
  echo -e "${YELLOW}[$(date +'%H:%M:%S')] WARNING: $1${NC}"
}

error() {
  echo -e "${RED}[$(date +'%H:%M:%S')] ERROR: $1${NC}"
}

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

check_ssh() {
  local host="$1"
  log "Checking SSH to ${host}"
  if ssh ${SSH_OPTS} "${host}" "echo OK" 2>/dev/null | grep -q OK; then
    log "SSH OK: ${host}"
    return 0
  fi
  error "Cannot SSH to ${host}"
  return 1
}

deploy_node() {
  local node="$1"
  log "Deploying on ${node}"

  run_via_lb "${node}" "mkdir -p ${PROJECT_PATH}"
  if run_via_lb "${node}" "[ -d ${PROJECT_PATH}/.git ]"; then
    run_via_lb "${node}" "cd ${PROJECT_PATH} && git fetch origin && git checkout ${GIT_BRANCH} && git pull --ff-only origin ${GIT_BRANCH}"
  else
    run_via_lb "${node}" "git clone --branch ${GIT_BRANCH} ${GIT_REPO} ${PROJECT_PATH}"
  fi

  run_via_lb "${node}" "cd ${PROJECT_PATH} && mkdir -p logs && npm ci --omit=dev"
  run_via_lb "${node}" "cd ${PROJECT_PATH} && pm2 start config/ecosystem.config.js --only game64x64 --update-env"
  run_via_lb "${node}" "pm2 save"
  run_via_lb "${node}" "curl -fsS http://127.0.0.1:3000/health"
}

configure_lb() {
  log "Syncing LB nginx config"
  run_ssh "${LB}" "test -f /etc/nginx/sites-available/game64x64-lb"
  run_ssh "${LB}" "cp /etc/nginx/sites-available/game64x64-lb /etc/nginx/sites-available/game64x64-lb.bak.$(date +%Y%m%d%H%M%S)"
  run_ssh "${LB}" "sed -i -E 's/server[[:space:]]+${NODE1_HOST}:[0-9]+/server ${NODE1_HOST}:3000/g; s/server[[:space:]]+${NODE2_HOST}:[0-9]+/server ${NODE2_HOST}:3000/g' /etc/nginx/sites-available/game64x64-lb"
  run_ssh "${LB}" "nginx -t"
  run_ssh "${LB}" "systemctl reload nginx"
}

verify_cluster() {
  log "Verifying node and LB health"
  run_via_lb "${NODE1}" "curl -fsS http://127.0.0.1:3000/health"
  run_via_lb "${NODE2}" "curl -fsS http://127.0.0.1:3000/health"
  run_ssh "${LB}" "curl -fsS http://127.0.0.1/health"
  run_ssh "${LB}" "curl -kfsS https://127.0.0.1/health || true"
}

print_summary() {
  echo ""
  echo "========================================"
  echo -e "${GREEN}DEPLOYMENT COMPLETE${NC}"
  echo "========================================"
  echo "Domain: https://${DOMAIN}"
  echo "LB: ${LB_HOST}:${SSH_PORT}"
  echo "Nodes: ${NODE1_HOST}:3000, ${NODE2_HOST}:3000"
  echo "Redis: ${REDIS_HOST}:${REDIS_PORT}"
  echo ""
  echo "Quick checks:"
  echo "  ssh -p ${SSH_PORT} ${LB} 'curl -fsS http://127.0.0.1/health'"
  echo "  ssh -p ${SSH_PORT} ${LB} 'ssh -p ${SSH_PORT} ${NODE1} \"pm2 status game64x64\"'"
  echo "  ssh -p ${SSH_PORT} ${LB} 'ssh -p ${SSH_PORT} ${NODE2} \"pm2 status game64x64\"'"
}

echo "========================================"
echo "Game64x64 PM2 Cluster Deploy"
echo "Domain: ${DOMAIN}"
echo "LB: ${LB}"
echo "Nodes: ${NODE1}, ${NODE2}"
echo "Branch: ${GIT_BRANCH}"
echo "Project: ${PROJECT_PATH}"
echo "========================================"
echo ""

check_ssh "${LB}"
run_ssh "${LB}" "ssh ${SSH_OPTS} ${NODE1} 'echo NODE1_OK'"
run_ssh "${LB}" "ssh ${SSH_OPTS} ${NODE2} 'echo NODE2_OK'"

deploy_node "${NODE1}"
deploy_node "${NODE2}"
configure_lb
verify_cluster
print_summary
