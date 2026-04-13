# Deployment Guide (HA: 2 App Node + LB + Shared Redis/Mongo)

## Tong quan
- App Node #1: `172.16.10.216` (`game64x64`, PORT=3000)
- App Node #2: `172.16.10.253` (`game64x64`, PORT=3000)
- Shared data node: `172.16.10.202` (Redis + MongoDB)
- Public LB: `103.252.74.109` / `172.16.10.202` (Nginx)

## 1) Cai dat Redis + MongoDB tren data node
```bash
sudo apt update
sudo apt install -y redis-server
sudo systemctl enable redis-server
sudo systemctl start redis-server
redis-cli -a ColorBox64x64_Redis_2026 ping
```

MongoDB tren Ubuntu 24.04:
```bash
curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc \
  | sudo gpg -o /usr/share/keyrings/mongodb-server-8.0.gpg --dearmor
echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu noble/mongodb-org/8.0 multiverse" \
  | sudo tee /etc/apt/sources.list.d/mongodb-org-8.0.list
sudo apt update
sudo apt install -y mongodb-org
sudo systemctl enable mongod
sudo systemctl start mongod
```

## 2) Trien khai app tren tung Node
Tren moi Node:
```bash
git clone <REPO_URL> game64x64
cd game64x64
npm install
mkdir -p logs
```

Tao tunnel local de app node truy cap MongoDB qua `127.0.0.1:37018`:
```bash
sudo tee /etc/systemd/system/game64x64-mongo-tunnel.service >/dev/null <<'EOF'
[Unit]
Description=Game64x64 MongoDB SSH Tunnel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
Restart=always
RestartSec=5
ExecStart=/usr/bin/ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o BatchMode=yes -o StrictHostKeyChecking=no -p 2357 -L 127.0.0.1:37018:172.16.10.202:27017 root@103.252.74.109

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now game64x64-mongo-tunnel
ss -lntp | grep 37018
```

Tao file `.env`:
```bash
PORT=3000
NODE_ENV=production
ENABLE_REDIS=true
REDIS_URL=redis://:ColorBox64x64_Redis_2026@172.16.10.202:6379
MONGO_URL=mongodb://127.0.0.1:37018
MONGO_DB_NAME=game64x64
REDIS_PLAYERS_KEY=game64x64:players
REDIS_USERS_KEY=game64x64:users
REDIS_SESSION_PREFIX=game64x64:session:
REDIS_USER_SESSION_PREFIX=game64x64:user-session:
MOVE_INTERVAL_MS=16
SNAPSHOT_INTERVAL_MS=250
AUTH_COOKIE_SECURE=true
TRUST_PROXY=true
ALLOW_LOOPBACK_MONGO_TUNNEL=true
AUTH_REQUIRE_MONGO=true
AUTH_REJECT_CONCURRENT=true
AUTH_SEED_TEST_USERS=false
AUTH_ALLOW_CONCURRENT_SEED_USERS=false
```

Chay PM2:
```bash
pm2 start config/ecosystem.config.js
pm2 save
pm2 startup
```

## 3) Cau hinh Nginx Load Balancer
Tren may Nginx:
```bash
sudo cp deploy/nginx.game64x64.lb.conf /etc/nginx/sites-available/game64x64-lb
sudo ln -s /etc/nginx/sites-available/game64x64-lb /etc/nginx/sites-enabled/game64x64-lb
sudo nginx -t
sudo systemctl reload nginx
```

LB hien tai:
- `172.16.10.216:80`
- `172.16.10.253:80`

Khuyen nghi giu `ip_hash` trong upstream de on dinh session khi fallback transport xay ra.

## 4) Verify nhanh
- Truy cap: `https://colorbox64x64.online/api/health`
- Mo 3 tab, di chuyen o tab 1, tab 2-3 phai cap nhat real-time.

## 5) Test failover
1. Dang de nguoi dung online.
2. Tren Node #1: `pm2 stop game64x64`
3. Kiem tra game van phuc vu qua Node #2.
4. Bat lai Node #1: `pm2 start game64x64`

## 6) Drain node truoc khi reboot
Tren LB:
```bash
sudo /usr/local/bin/game64x64-node-state status
sudo /usr/local/bin/game64x64-node-state drain 172.16.10.216
sudo /usr/local/bin/game64x64-node-state undrain 172.16.10.216
```

## 7) Kiem tra dong bo Redis
```bash
redis-cli -a ColorBox64x64_Redis_2026 -h 172.16.10.202 HLEN game64x64:players
redis-cli -a ColorBox64x64_Redis_2026 -h 172.16.10.202 HGETALL game64x64:players
```

## Van hanh
```bash
pm2 logs game64x64
pm2 restart config/ecosystem.config.js --only game64x64 --update-env
pm2 status
```
