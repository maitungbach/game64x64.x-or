#!/bin/bash
set -e

# ========================================
# Game64x64 Cluster Deployment Script
# Domain: colorbox64x64.online
# Nodes: 172.16.10.253, 172.16.10.216
# Redis: 172.16.10.202:6379
# LB: 172.16.10.202 (Public: 103.252.74.109)
# ========================================

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Configuration
DOMAIN="colorbox64x64.online"
REDIS_HOST="172.16.10.202"
REDIS_PORT="6379"
NODE1="root@172.16.10.253"
NODE2="root@172.16.10.216"
LB="root@172.16.10.202"
PROJECT_PATH="/var/www/game64x64"
GIT_REPO="https://github.com/maitungbach/game64x64.x-or.git"
GIT_BRANCH="main"

# SSH options (use key-based auth)
SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=15"

log() {
    echo -e "${GREEN}[$(date +'%H:%M:%S')] $1${NC}"
}

error() {
    echo -e "${RED}[$(date +'%H:%M:%S')] ERROR: $1${NC}"
}

warn() {
    echo -e "${YELLOW}[$(date +'%H:%M:%S')] WARNING: $1${NC}"
}

# Check SSH connectivity
check_ssh() {
    local host=$1
    log "Checking SSH to $host..."
    if ssh $SSH_OPTS $host "echo OK" 2>/dev/null | grep -q OK; then
        log "✓ SSH to $host successful"
        return 0
    else
        error "Cannot SSH to $host"
        return 1
    fi
}

# Run command on remote
run() {
    local host=$1
    local cmd=$2
    ssh $SSH_OPTS $host "$cmd" 2>&1
}

# Copy file to remote
copy() {
    local host=$1
    local src=$2
    local dst=$3
    scp $SSH_OPTS "$src" "$host:$dst" 2>&1
}

# ========================================
# MAIN DEPLOYMENT
# ========================================

echo "========================================"
echo "Game64x64 Cluster Deployment"
echo "Domain: $DOMAIN"
echo "Nodes: 172.16.10.253, 172.16.10.216"
echo "Redis: $REDIS_HOST:$REDIS_PORT"
echo "========================================"
echo ""

# Pre-flight checks
log "Checking SSH connectivity..."
check_ssh $NODE1 || exit 1
check_ssh $NODE2 || exit 1
check_ssh $LB || exit 1

# Create deploy directory locally
mkdir -p deploy
cd deploy

# ========================================
# Generate Configuration Files
# ========================================

log "Generating configuration files..."

# 1. .env.production
cat > .env.production << EOF
NODE_ENV=production
PORT=5001

ENABLE_REDIS=true
REDIS_URL=redis://${REDIS_HOST}:${REDIS_PORT}

AUTH_REQUIRE_MONGO=false
MONGO_URL=

BROADCAST_INTERVAL_MS=33
MOVE_INTERVAL_MS=16
SNAPSHOT_INTERVAL_MS=250
GRID_SIZE=64
MAX_SPAWN_ATTEMPTS=100

AUTH_COOKIE_NAME=game64x64_session
AUTH_COOKIE_SECURE=true
AUTH_SESSION_TTL_SEC=86400
AUTH_REJECT_CONCURRENT=false
AUTH_RELEASE_DELAY_MS=60000
AUTH_SEED_TEST_USERS=true
AUTH_ALLOW_CONCURRENT_SEED_USERS=true
ADMIN_EMAILS=mtungbach@gmail.com

REDIS_PLAYERS_KEY=game64x64:players
REDIS_CELLS_KEY=game64x64:cells
REDIS_USERS_KEY=game64x64:users
REDIS_SESSION_PREFIX=game64x64:session:
REDIS_USER_SESSION_PREFIX=game64x64:user-session:
EOF

# 2. ecosystem.config.js
cat > ecosystem.config.js << 'EOF'
module.exports = {
  apps: [{
    name: 'game64x64',
    cwd: '/var/www/game64x64',
    script: 'src/server.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production',
      PORT: 5001
    },
    error_file: '/var/log/game64x64.error.log',
    out_file: '/var/log/game64x64.out.log',
    log_file: '/var/log/game64x64.combined.log',
    time: true
  }]
};
EOF

# 3. systemd service
cat > game64x64.service << 'EOF'
[Unit]
Description=Game64x64 Node.js Server
After=network.target redis.service
Wants=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/var/www/game64x64
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=10
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=game64x64
Environment=NODE_ENV=production
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

# 4. Nginx config for LB
cat > nginx.conf << EOF
upstream game64x64_backend {
    zone game64x64_backend 64k;
    server 172.16.10.253:5001 max_fails=1 fail_timeout=10s;
    server 172.16.10.216:5001 max_fails=1 fail_timeout=10s;
    least_conn;
    keepalive 64;
}

server {
    listen 80;
    server_name ${DOMAIN} www.${DOMAIN};
    return 301 https://\$server_name\$request_uri;
}

server {
    listen 443 ssl http2;
    server_name ${DOMAIN} www.${DOMAIN};

    ssl_certificate /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-RSA-AES256-GCM-SHA512:DHE-RSA-AES256-GCM-SHA512;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;

    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    access_log /var/log/nginx/game64x64_access.log;
    error_log /var/log/nginx/game64x64_error.log;

    location / {
        proxy_pass http://game64x64_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-Host \$host;
        proxy_set_header X-Forwarded-Port \$server_port;
        proxy_connect_timeout 5s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
        proxy_buffering off;
        proxy_next_upstream error timeout invalid_header http_500 http_502 http_503 http_504;
        proxy_next_upstream_tries 2;
        proxy_next_upstream_timeout 5s;
    }

    location /health {
        access_log off;
        proxy_pass http://game64x64_backend;
        proxy_next_upstream error timeout invalid_header http_500 http_502 http_503 http_504;
        proxy_next_upstream_tries 2;
        proxy_next_upstream_timeout 3s;
    }

    location /api/ {
        proxy_pass http://game64x64_backend;
        add_header Cache-Control "no-store, no-cache, must-revalidate" always;
        proxy_next_upstream error timeout invalid_header http_500 http_502 http_503 http_504;
        proxy_next_upstream_tries 2;
        proxy_next_upstream_timeout 5s;
    }
}
EOF

# 5. Quick install script for nodes
cat > install-node.sh << 'EOF'
#!/bin/bash
set -e

echo "Installing Node.js & PM2..."
apt update
apt install -y nodejs npm curl
npm install -g pm2

echo "Creating project directory..."
mkdir -p /var/www/game64x64
chmod 755 /var/www/game64x64

echo "Done."
EOF

chmod +x install-node.sh

# ========================================
# DEPLOY TO NODES
# ========================================

log "=== DEPLOYING TO NODE 1 (172.16.10.253) ==="

run $NODE1 "bash -s" < install-node.sh

run $NODE1 "mkdir -p $PROJECT_PATH"
copy $NODE1 ".env.production" "$PROJECT_PATH/.env"
copy $NODE1 "ecosystem.config.js" "$PROJECT_PATH/ecosystem.config.js"
copy $NODE1 "game64x64.service" "/etc/systemd/system/game64x64.service"

# Clone repo
log "Cloning repository on Node1..."
if run $NODE1 "[ -d $PROJECT_PATH/.git ]"; then
    log "Repo exists, pulling latest..."
    run $NODE1 "cd $PROJECT_PATH && git fetch origin && git checkout $GIT_BRANCH && git pull origin $GIT_BRANCH"
else
    log "Cloning fresh repo..."
    run $NODE1 "git clone $GIT_REPO $PROJECT_PATH"
fi

log "Installing dependencies on Node1..."
run $NODE1 "cd $PROJECT_PATH && npm ci --only=production"

log "Starting service on Node1..."
run $NODE1 "systemctl daemon-reload && systemctl enable game64x64 && systemctl restart game64x64"

sleep 2
run $NODE1 "systemctl status game64x64 --no-pager"

log "=== DEPLOYING TO NODE 2 (172.16.10.216) ==="

run $NODE2 "bash -s" < install-node.sh

run $NODE2 "mkdir -p $PROJECT_PATH"
copy $NODE2 ".env.production" "$PROJECT_PATH/.env"
copy $NODE2 "ecosystem.config.js" "$PROJECT_PATH/ecosystem.config.js"
copy $NODE2 "game64x64.service" "/etc/systemd/system/game64x64.service"

log "Cloning repository on Node2..."
if run $NODE2 "[ -d $PROJECT_PATH/.git ]"; then
    run $NODE2 "cd $PROJECT_PATH && git fetch origin && git checkout $GIT_BRANCH && git pull origin $GIT_BRANCH"
else
    run $NODE2 "git clone $GIT_REPO $PROJECT_PATH"
fi

log "Installing dependencies on Node2..."
run $NODE2 "cd $PROJECT_PATH && npm ci --only=production"

log "Starting service on Node2..."
run $NODE2 "systemctl daemon-reload && systemctl enable game64x64 && systemctl restart game64x64"

sleep 2
run $NODE2 "systemctl status game64x64 --no-pager"

# ========================================
# CONFIGURE LOAD BALANCER
# ========================================

log "=== CONFIGURING LOAD BALANCER (172.16.10.202) ==="

run $LB "apt update && apt install -y nginx certbot python3-certbot-nginx"

copy $LB "nginx.conf" "/etc/nginx/conf.d/game64x64.conf"

log "Testing Nginx config..."
run $LB "nginx -t"

log "Reloading Nginx..."
run $LB "systemctl reload nginx"

# ========================================
# SSL CERTIFICATE
# ========================================

log "=== SETTING UP SSL CERTIFICATE ==="

run $LB "certbot --nginx -d ${DOMAIN} -d www.${DOMAIN} --non-interactive --agree-tos -m admin@${DOMAIN} 2>/dev/null || echo 'SSL may already exist or need manual verification'"

# ========================================
# VERIFICATION
# ========================================

log "=== VERIFYING DEPLOYMENT ==="

echo ""
echo "Waiting for services to start..."
sleep 3

# Check nodes
echo ""
log "Checking Node 1..."
run $NODE1 "curl -s http://localhost:5001/health || echo 'FAILED'"

log "Checking Node 2..."
run $NODE2 "curl -s http://localhost:5001/health || echo 'FAILED'"

log "Checking Load Balancer..."
run $LB "curl -s http://localhost/health || echo 'FAILED'"

echo ""
log "Checking HTTPS endpoint..."
run $LB "curl -s -k https://localhost/health || echo 'HTTPS check failed (may need cert activation)'"

# ========================================
# SUMMARY
# ========================================

echo ""
echo "========================================"
echo -e "${GREEN}DEPLOYMENT COMPLETE!${NC}"
echo "========================================"
echo ""
echo "Domain: https://${DOMAIN}"
echo "LB: 172.16.10.202 (Public: 103.252.74.109)"
echo ""
echo "Nodes:"
echo "  Node 1: 172.16.10.253:5001 (internal)"
echo "  Node 2: 172.16.10.216:5001 (internal)"
echo ""
echo "Redis: ${REDIS_HOST}:${REDIS_PORT}"
echo ""
echo "Test:"
echo "  curl https://${DOMAIN}/health"
echo "  curl https://${DOMAIN}/api/health"
echo ""
echo "Management:"
echo "  Node1:    ssh $NODE1 'systemctl status game64x64'"
echo "  Node2:    ssh $NODE2 'systemctl status game64x64'"
echo "  LB:       ssh $LB 'systemctl status nginx'"
echo "  Logs N1:  ssh $NODE1 'journalctl -u game64x64 -f'"
echo "  Logs N2:  ssh $NODE2 'journalctl -u game64x64 -f'"
echo "  PM2 N1:   ssh $NODE1 'pm2 logs game64x64'"
echo "  PM2 N2:   ssh $NODE2 'pm2 logs game64x64'"
echo ""
echo "Test accounts:"
echo "  tester01@example.com / Test123! (admin)"
echo "  tester02@example.com / Test123!"
echo "  tester03@example.com / Test123!"
echo "  tester04@example.com / Test123!"
echo "  tester05@example.com / Test123!"
echo ""
echo "========================================"
