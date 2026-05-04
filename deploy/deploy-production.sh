#!/bin/bash

NODE1="root@172.16.10.253"
NODE2="root@172.16.10.216"
PROJECT_PATH="/opt/game64x64"
GIT_BRANCH="no-walls-pickup"
DOMAIN="colorbox64x64.online"
SSH_PORT=2357

ssh_opts="-p $SSH_PORT -o StrictHostKeyChecking=no"

deploy_node() {
  local node="$1"
  echo "=== Deploying to $node ==="

  ssh $ssh_opts "$node" "mkdir -p $PROJECT_PATH"
  ssh $ssh_opts "$node" "cd $PROJECT_PATH && if [ -d .git ]; then git fetch origin && git checkout $GIT_BRANCH && git pull --ff-only origin $GIT_BRANCH; else git clone --branch $GIT_BRANCH https://github.com/maitungbach/game64x64.x-or.git .; fi"
  ssh $ssh_opts "$node" "cd $PROJECT_PATH && npm install --omit=dev"
  ssh $ssh_opts "$node" "cat > $PROJECT_PATH/.env << EOF
PORT=3000
NODE_ENV=production
ENABLE_REDIS=true
REDIS_HOST=172.16.10.202
REDIS_PORT=6379
DOMAIN=$DOMAIN
EOF"
  ssh $ssh_opts "$node" "cd $PROJECT_PATH && pm2 start config/ecosystem.config.js --only game64x64 --update-env"
  ssh $ssh_opts "$node" "pm2 save"
  ssh $ssh_opts "$node" "sleep 3"
  if ssh $ssh_opts "$node" "curl -fsS http://127.0.0.1:3000/health"; then
    echo "Health check OK on $node"
  else
    echo "WARNING: Health check failed on $node (server may still be starting)"
  fi
}

deploy_node "$NODE1"
deploy_node "$NODE2"

echo "========================================"
echo "DEPLOYMENT COMPLETE"
echo "Domain: https://$DOMAIN"
echo "Nodes: $NODE1:3000, $NODE2:3000"
echo "========================================"
