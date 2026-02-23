# Deployment Guide (HA: 2 Node + Redis + Nginx LB)

## Tong quan
- Node #1: app `game64x64` (PORT=3000)
- Node #2: app `game64x64` (PORT=3000)
- Redis: dung chung cho ca 2 node
- Nginx LB: route traffic vao 2 node

## 1) Cai dat Redis (co the tren server rieng)
```bash
sudo apt update
sudo apt install -y redis-server
sudo systemctl enable redis-server
sudo systemctl start redis-server
redis-cli ping
```

## 2) Trien khai app tren tung Node
Tren moi Node:
```bash
git clone <REPO_URL> game64x64
cd game64x64
npm install
mkdir -p logs
```

Tao file `.env`:
```bash
PORT=3000
NODE_ENV=production
ENABLE_REDIS=true
REDIS_URL=redis://<REDIS_HOST>:6379
REDIS_PLAYERS_KEY=game64x64:players
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

Luu y: doi IP `10.0.0.11` va `10.0.0.12` thanh IP Node that.

## 4) Verify nhanh
- Truy cap: `http://<LB_IP>/health`
- Mo 3 tab, di chuyen o tab 1, tab 2-3 phai cap nhat real-time.

## 5) Test failover
1. Dang de nguoi dung online.
2. Tren Node #1: `pm2 stop game64x64`
3. Kiem tra game van phuc vu qua Node #2.
4. Bat lai Node #1: `pm2 start game64x64`

## 6) Kiem tra dong bo Redis
```bash
redis-cli HLEN game64x64:players
redis-cli HGETALL game64x64:players
```

## Van hanh
```bash
pm2 logs game64x64
pm2 restart game64x64
pm2 status
```
